import { User } from '@phosphor-icons/react'
import { formatTime } from '../../lib/format'
import { TokenUsagePill } from './TokenUsagePill'
import type { TokenUsageSummary } from './context-tokens'

interface Props {
  text: string
  queued?: boolean
  images?: Array<{ mediaType: string; data?: string; imageRef?: ImageRefPointer }>
  createdAt: string
  tokenUsage?: TokenUsageSummary
}

interface ImageRefPointer {
  path?: string
  relativePath?: string
  sha256?: string
  bytes?: number
}

export function UserMessageBlock({ text, queued = false, images, createdAt, tokenUsage }: Props) {
  const hasImages = Boolean(images && images.length > 0)
  const displayText = hasImages ? stripImagePlaceholders(text) : text
  const showText = displayText.trim().length > 0

  return (
    <div className="overflow-hidden rounded-[22px] border border-cyan-400/18 bg-[linear-gradient(135deg,rgba(34,211,238,0.14),rgba(13,17,24,0.92))] px-4 py-4 shadow-[0_18px_40px_rgba(0,0,0,0.2)]">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-400/12">
          <User size={16} weight="bold" className="text-cyan-200" />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-100/90">
              User Prompt
            </span>
            {queued && (
              <span className="inline-flex items-center rounded-full border border-cyan-300/30 bg-cyan-300/10 px-2 py-0.5 text-[10px] font-mono uppercase tracking-[0.16em] text-cyan-200">
                Queued
              </span>
            )}
            <span className="text-[10px] font-mono text-cyan-100/55">{formatTime(createdAt)}</span>
            <TokenUsagePill usage={tokenUsage} />
          </div>
          {showText && (
            <p className="text-[13px] leading-6 text-[var(--color-text-primary)] whitespace-pre-wrap">
              {displayText}
            </p>
          )}
          {images?.map((image, index) =>
            image.data ? (
              <img
                key={`${image.mediaType}-${index}`}
                src={`data:${image.mediaType};base64,${image.data}`}
                alt={`User upload ${index + 1}`}
                className="max-h-72 rounded-md border border-white/10 object-contain bg-black/20"
              />
            ) : (
              <div
                key={`${image.mediaType}-${index}-${image.imageRef?.sha256 ?? 'ref'}`}
                className="rounded-md border border-white/10 bg-black/20 px-3 py-2 font-mono text-[11px] text-cyan-100/65"
              >
                {image.imageRef?.relativePath ?? image.imageRef?.path ?? image.mediaType}
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  )
}

function stripImagePlaceholders(text: string): string {
  return text
    .replace(/^\s*\[(?:图片|Image(?:\s*#?\d+)?)\]\s*$/gim, '')
    .replace(/(?:\r?\n){3,}/g, '\n\n')
    .trim()
}
