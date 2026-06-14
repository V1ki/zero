import { X } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWebSocket } from '../../useWebSocket'
import { apiFetch, apiPost } from '../../lib/api'
import { useUIStore } from '../../stores/ui'
import { ChatDrawerInput } from './ChatDrawerInput'
import { ChatDrawerMessageList } from './ChatDrawerMessageList'
import {
  type ChatMessage,
  type SessionMessage,
  createChatMessage,
  isKnownModelName,
  toChatMessages,
} from './chat-drawer-messages'

export { shouldRenderAssistantAsPlainText } from './chat-drawer-messages'

export function ChatDrawer() {
  const { chatDrawerOpen, toggleChatDrawer, isMobile } = useUIStore()
  const [message, setMessage] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [modelName, setModelName] = useState('unknown')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const modelNameRef = useRef(modelName)
  const lastMessage = messages[messages.length - 1]

  const updateModelName = useCallback((nextModel: string) => {
    modelNameRef.current = nextModel
    setModelName(nextModel)
  }, [])

  useEffect(() => {
    if (!lastMessage) return
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lastMessage])

  // Esc-to-close
  useEffect(() => {
    if (!chatDrawerOpen) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        toggleChatDrawer()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [chatDrawerOpen, toggleChatDrawer])

  // Restore current web session and model
  useEffect(() => {
    if (chatDrawerOpen) {
      apiFetch<{ currentModel: string }>('/api/status')
        .then(async (statusRes) => {
          if (isKnownModelName(statusRes.currentModel)) {
            updateModelName(statusRes.currentModel)
          }

          const currentRes = await apiFetch<{
            sessions: Array<{ id: string }>
          }>('/api/sessions/source/web/current')
          const current = currentRes.sessions?.[0]

          if (!current?.id) {
            setSessionId(null)
            setMessages([])
            return
          }

          const detail = await apiFetch<{
            id: string
            currentModel: string
            messages: SessionMessage[]
          }>(`/api/sessions/${current.id}`)

          setSessionId(detail.id)
          updateModelName(detail.currentModel)
          setMessages(toChatMessages(detail.messages))
        })
        .catch(() => {})
    }
  }, [chatDrawerOpen, updateModelName])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const textLength = message.length
    textarea.style.height = 'auto'
    const maxHeight = 4 * 24
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`
    textarea.style.overflowY =
      textLength > 0 && textarea.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [message])

  // WebSocket: receive notification cards + streaming deltas
  const onEvent = useCallback((topic: string, data: unknown) => {
    if (topic === 'notification') {
      const payload = data as Record<string, unknown>
      const n = payload.notification as
        | { title?: string; description?: string; severity?: string }
        | undefined
      if (n) {
        setMessages((prev) => [
          ...prev,
          createChatMessage({
            role: 'notification' as const,
            content: n.description ?? '',
            title: n.title,
            severity: n.severity,
          }),
        ])
      }
    }
  }, [])

  const onStream = useCallback(
    (_sid: string, delta: string) => {
      if (!streaming) return
      setMessages((prev) => {
        const last = prev[prev.length - 1]
        if (last && last.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, content: last.content + delta }]
        }
        return [...prev, createChatMessage({ role: 'assistant', content: delta })]
      })
    },
    [streaming],
  )

  const { send: wsSend } = useWebSocket({
    url: `ws://${window.location.host}/ws`,
    topics: ['notification', 'stream'],
    onEvent,
    onStream,
  })

  if (!chatDrawerOpen) return null

  async function handleCommand(text: string): Promise<boolean> {
    if (text === '/new') {
      try {
        const result = await apiPost<{
          sessionId: string
          currentModel: string
        }>('/api/chat/new', {})
        setSessionId(result.sessionId)
        updateModelName(result.currentModel)
        setMessages([
          createChatMessage({
            role: 'assistant',
            content: `New conversation started with model: ${result.currentModel}`,
          }),
        ])
      } catch {
        setMessages((prev) => [
          ...prev,
          createChatMessage({
            role: 'assistant',
            content: 'Failed to start a new conversation.',
          }),
        ])
      }
      return true
    }

    const modelMatch = text.match(/^\/model\s+(.+)$/)
    if (modelMatch) {
      const newModel = modelMatch[1].trim()
      try {
        const result = await apiPost<{ currentModel: string }>('/api/chat/model', {
          model: newModel,
          sessionId,
        })
        updateModelName(result.currentModel)
        setMessages((prev) => [
          ...prev,
          createChatMessage({
            role: 'assistant',
            content: `Model switched to ${result.currentModel}`,
          }),
        ])
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error'
        setMessages((prev) => [
          ...prev,
          createChatMessage({
            role: 'assistant',
            content: `Failed to switch model: ${errMsg}`,
          }),
        ])
      }
      return true
    }

    return false
  }

  async function sendMessage() {
    const text = message.trim()
    if (!text || loading) return

    setMessage('')
    setMessages((prev) => [...prev, createChatMessage({ role: 'user', content: text })])

    // Handle slash commands
    if (text.startsWith('/')) {
      const handled = await handleCommand(text)
      if (handled) return
    }

    setLoading(true)

    try {
      // Attempt WS streaming
      setStreaming(true)
      wsSend({ type: 'chat', sessionId, message: text })

      // POST for the full response
      const res = await apiPost<{ sessionId: string; reply: string }>('/api/chat', {
        message: text,
        sessionId,
      })
      setSessionId(res.sessionId)
      setStreaming(false)

      // Replace any partial streaming with the final reply
      setMessages((prev) => {
        const lastIdx = prev.length - 1
        if (lastIdx >= 0 && prev[lastIdx].role === 'assistant') {
          return [
            ...prev.slice(0, lastIdx),
            createChatMessage({ role: 'assistant', content: res.reply }),
          ]
        }
        return [...prev, createChatMessage({ role: 'assistant', content: res.reply })]
      })
    } catch (err) {
      setStreaming(false)
      const errMsg = err instanceof Error ? err.message : 'Unknown error'
      setMessages((prev) => [
        ...prev,
        createChatMessage({ role: 'assistant', content: `Error: ${errMsg}` }),
      ])
    } finally {
      setLoading(false)
    }
  }

  const drawerClasses = isMobile
    ? 'fixed inset-0 w-full h-full z-50'
    : 'fixed right-0 top-0 h-full w-[360px] z-50'

  return (
    <div
      className={`${drawerClasses} bg-[var(--color-main-bg)] border-l border-[var(--color-border)] flex flex-col`}
      style={
        !isMobile ? { animation: 'slideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards' } : undefined
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold">Chat</span>
          <span className="text-[11px] text-[var(--color-text-muted)] font-mono">
            Web Channel · {modelName}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleChatDrawer}
          className="p-1 rounded-md hover:bg-white/[0.05] text-[var(--color-text-muted)]"
        >
          <X size={18} />
        </button>
      </div>

      <ChatDrawerMessageList
        messages={messages}
        loading={loading}
        messagesEndRef={messagesEndRef}
      />

      <ChatDrawerInput
        message={message}
        loading={loading}
        textareaRef={textareaRef}
        onMessageChange={setMessage}
        onSend={sendMessage}
      />

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
