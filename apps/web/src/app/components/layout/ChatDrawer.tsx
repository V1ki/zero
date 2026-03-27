import { ClipboardText, PaperPlaneRight, X } from '@phosphor-icons/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useWebSocket } from '../../hooks/useWebSocket'
import { apiFetch, apiPost } from '../../lib/api'
import { useUIStore } from '../../stores/ui'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'notification'
  content: string
  title?: string
  severity?: string
}

export function shouldRenderAssistantAsPlainText(content: string): boolean {
  if (!content.includes('\n')) return false

  return !/(^|\n)\s*(#{1,6}\s|\d+\.\s|[-*+]\s|>\s|```|\|.+\|)/m.test(content)
}

function createChatMessage(message: Omit<ChatMessage, 'id'>): ChatMessage {
  return { id: crypto.randomUUID(), ...message }
}

function isKnownModelName(modelName: string | null | undefined): modelName is string {
  return Boolean(modelName && modelName !== 'unknown')
}

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

  function updateModelName(nextModel: string) {
    modelNameRef.current = nextModel
    setModelName(nextModel)
  }

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

  // Fetch current model name
  useEffect(() => {
    if (chatDrawerOpen) {
      apiFetch<{ currentModel: string }>('/api/status')
        .then((res) => updateModelName(res.currentModel))
        .catch(() => {})
    }
  }, [chatDrawerOpen])

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
      setSessionId(null)
      let currentModel: string | undefined

      try {
        const result = await apiFetch<{ currentModel: string }>('/api/status')
        if (isKnownModelName(result.currentModel)) {
          currentModel = result.currentModel
          updateModelName(result.currentModel)
        }
      } catch {
        // Fall back to the locally cached model label for the status message.
      }

      if (!currentModel && isKnownModelName(modelNameRef.current)) {
        currentModel = modelNameRef.current
      }

      setMessages([
        createChatMessage({
          role: 'assistant',
          content: currentModel
            ? `New conversation started with model: ${currentModel}`
            : 'New session started.',
        }),
      ])
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

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="text-center text-[var(--color-text-muted)] text-[13px] py-12">
            Send a message to interact with ZeRo OS
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === 'notification') {
            return (
              <div
                key={msg.id}
                className="rounded-lg border border-[var(--color-border)] p-3 bg-white/[0.02]"
              >
                <div className="flex items-center gap-2 mb-1">
                  <ClipboardText size={14} className="text-amber-400" />
                  <span className="text-[12px] font-medium text-amber-400">
                    {msg.title ?? 'Notification'}
                  </span>
                </div>
                <p className="text-[12px] text-[var(--color-text-secondary)]">{msg.content}</p>
              </div>
            )
          }

          return (
            <div
              key={msg.id}
              className={`text-[13px] ${
                msg.role === 'user'
                  ? 'ml-8 border-l-2 border-cyan-400 pl-3 py-2 text-[var(--color-text-primary)]'
                  : 'mr-4 text-[var(--color-text-secondary)]'
              }`}
            >
              {msg.role === 'assistant' ? (
                shouldRenderAssistantAsPlainText(msg.content) ? (
                  <div className="whitespace-pre-wrap break-words text-[var(--color-text-secondary)]">
                    {msg.content}
                  </div>
                ) : (
                  <div className="prose prose-invert prose-sm max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  </div>
                )
              ) : (
                msg.content
              )}
            </div>
          )
        })}

        {loading && (
          <div className="flex items-center gap-1.5 py-2">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 border-t border-[var(--color-border)]">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Send a message..."
            className="input-field flex-1 resize-none min-h-[38px] py-2"
            rows={1}
            disabled={loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && message.trim() && !loading) {
                e.preventDefault()
                sendMessage()
              }
            }}
          />
          <button
            type="button"
            className="p-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-deep-bg)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 shrink-0"
            disabled={!message.trim() || loading}
            onClick={sendMessage}
          >
            <PaperPlaneRight size={18} weight="fill" />
          </button>
        </div>
      </div>

      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
      `}</style>
    </div>
  )
}
