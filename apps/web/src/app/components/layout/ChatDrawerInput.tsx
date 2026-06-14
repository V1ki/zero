import { PaperPlaneRight } from '@phosphor-icons/react'
import type { RefObject } from 'react'

interface ChatDrawerInputProps {
  message: string
  loading: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
  onMessageChange: (message: string) => void
  onSend: () => void
}

export function ChatDrawerInput({
  message,
  loading,
  textareaRef,
  onMessageChange,
  onSend,
}: ChatDrawerInputProps) {
  return (
    <div className="p-3 border-t border-[var(--color-border)]">
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => onMessageChange(e.target.value)}
          placeholder="Send a message..."
          className="input-field flex-1 resize-none min-h-[38px] py-2"
          rows={1}
          disabled={loading}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && message.trim() && !loading) {
              e.preventDefault()
              onSend()
            }
          }}
        />
        <button
          type="button"
          className="p-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-deep-bg)] hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40 shrink-0"
          disabled={!message.trim() || loading}
          onClick={onSend}
        >
          <PaperPlaneRight size={18} weight="fill" />
        </button>
      </div>
    </div>
  )
}
