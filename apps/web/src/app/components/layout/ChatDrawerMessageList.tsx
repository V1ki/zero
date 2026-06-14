import { ClipboardText } from '@phosphor-icons/react'
import type { RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from './chat-drawer-messages'
import { shouldRenderAssistantAsPlainText } from './chat-drawer-messages'

interface ChatDrawerMessageListProps {
  messages: ChatMessage[]
  loading: boolean
  messagesEndRef: RefObject<HTMLDivElement | null>
}

export function ChatDrawerMessageList({
  messages,
  loading,
  messagesEndRef,
}: ChatDrawerMessageListProps) {
  return (
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
  )
}
