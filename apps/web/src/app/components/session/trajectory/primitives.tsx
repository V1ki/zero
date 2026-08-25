/**
 * Local replacements for the DeepSeek Harness ui-primitives used by the ported
 * trajectory view: icons, Tooltip, JsonTree, MarkdownText, and the bounded
 * Markdown plain-text extractor. APIs mirror the DSH originals so the ported
 * sources compile unchanged.
 */

import { CaretRight, GearSix, MagnifyingGlass, Sparkle, User } from '@phosphor-icons/react'
import {
  type FocusEventHandler,
  type MouseEventHandler,
  type MutableRefObject,
  type ReactElement,
  type ReactNode,
  type Ref,
  cloneElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface IconProps {
  size?: number
  className?: string
}

export function IconChevronRightOutline14({ size = 14, className }: IconProps) {
  return <CaretRight aria-hidden size={size} className={className} />
}

export function IconSettingsOutline16({ size = 16, className }: IconProps) {
  return <GearSix aria-hidden size={size} className={className} />
}

export function IconSparkle16({ size = 16, className }: IconProps) {
  return <Sparkle aria-hidden size={size} className={className} />
}

export function IconUserOutline16({ size = 16, className }: IconProps) {
  return <User aria-hidden size={size} className={className} />
}

export function IconSearchOutline16({ size = 16, className }: IconProps) {
  return <MagnifyingGlass aria-hidden size={size} className={className} />
}

type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

interface TooltipProps {
  label: ReactNode | (() => ReactNode)
  side?: TooltipSide
  delayMs?: number
  children: ReactElement<TooltipAnchorProps>
}

/** Props Tooltip injects into its anchor child; the child's own handlers are chained ahead of the tooltip's. */
interface TooltipAnchorProps {
  ref?: Ref<HTMLElement> | undefined
  onMouseEnter?: MouseEventHandler | undefined
  onMouseLeave?: MouseEventHandler | undefined
  onFocus?: FocusEventHandler | undefined
  onBlur?: FocusEventHandler | undefined
}

interface TooltipAnchorRect {
  left: number
  right: number
  top: number
  bottom: number
}

const TOOLTIP_EDGE_MARGIN = 12
const TOOLTIP_GAP = 8

const TOOLTIP_TRANSFORM: Record<TooltipSide, string> = {
  top: 'translate(-50%, -100%)',
  right: 'translateY(-50%)',
  bottom: 'translateX(-50%)',
  left: 'translateY(-50%)',
}

function tooltipBasePoint(anchor: TooltipAnchorRect, side: TooltipSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: (anchor.left + anchor.right) / 2, y: anchor.top - TOOLTIP_GAP }
    case 'bottom':
      return { x: (anchor.left + anchor.right) / 2, y: anchor.bottom + TOOLTIP_GAP }
    case 'right':
      return { x: anchor.right + TOOLTIP_GAP, y: (anchor.top + anchor.bottom) / 2 }
    case 'left':
      return { x: anchor.left - TOOLTIP_GAP, y: (anchor.top + anchor.bottom) / 2 }
  }
}

/**
 * Attach a hover/focus tooltip to an anchor element.
 *
 * Mirrors the DSH original: the anchor is the child element itself
 * (cloneElement, no wrapper node), so attaching a tooltip never changes the
 * anchor's layout context — the timeline spans rely on this, because a
 * positioned wrapper would become their containing block and collapse their
 * percentage positioning. The bubble is position: fixed and coordinates come
 * from the anchor's rect at show time, so it escapes ancestor overflow
 * clipping.
 */
export function Tooltip({ label, side = 'top', delayMs = 400, children }: TooltipProps) {
  const anchorRef = useRef<HTMLElement | null>(null)
  // React 18 keeps the element's ref outside props; forward it so wrapping an
  // anchor in Tooltip never silently severs the owner's ref.
  const childRef = (children as ReactElement<TooltipAnchorProps> & { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback(
    (el: HTMLElement | null) => {
      anchorRef.current = el
      if (typeof childRef === 'function') childRef(el)
      else if (childRef != null) (childRef as MutableRefObject<HTMLElement | null>).current = el
    },
    [childRef],
  )
  const [anchor, setAnchor] = useState<TooltipAnchorRect | null>(null)
  const [placement, setPlacement] = useState<TooltipSide>(side)
  const bubbleRef = useRef<HTMLSpanElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Hover and focus are independent triggers: the bubble hides only after
  // BOTH clear (hovering away from a focused anchor must not drop it).
  const triggersRef = useRef({ hover: false, focus: false })
  const content = anchor === null ? null : typeof label === 'function' ? label() : label

  const cancelShow = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const show = useCallback(() => {
    const el = anchorRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    // Every show starts from the requested side; the fit pass flips it only
    // where this anchor's position demands it.
    setPlacement(side)
    setAnchor({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })
  }, [side])

  const showAfterHoverDelay = useCallback(() => {
    cancelShow()
    if (delayMs <= 0) {
      show()
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      show()
    }, delayMs)
  }, [cancelShow, delayMs, show])

  const hide = useCallback(() => {
    cancelShow()
    if (!triggersRef.current.hover && !triggersRef.current.focus) setAnchor(null)
  }, [cancelShow])

  // biome-ignore lint/correctness/useExhaustiveDependencies: content re-runs the fit because a changed label resizes the bubble
  useLayoutEffect(() => {
    if (anchor === null) return
    const fit = () => {
      const bubble = bubbleRef.current
      /* v8 ignore next -- the bubble is mounted whenever anchor is set. */
      if (bubble === null) return
      // Reset to the base point before measuring, so a previous fit adjustment
      // never compounds across resize or label changes.
      const point = tooltipBasePoint(anchor, placement)
      bubble.style.left = `${point.x}px`
      bubble.style.top = `${point.y}px`
      const rect = bubble.getBoundingClientRect()
      let dx = 0
      if (rect.right > window.innerWidth - TOOLTIP_EDGE_MARGIN)
        dx = window.innerWidth - TOOLTIP_EDGE_MARGIN - rect.right
      if (rect.left + dx < TOOLTIP_EDGE_MARGIN) dx = TOOLTIP_EDGE_MARGIN - rect.left
      bubble.style.left = `${point.x + dx}px`
      // Flip vertically only into a side that genuinely fits, so an anchor
      // with room on neither side keeps the requested placement instead of
      // oscillating.
      const fitsBelow =
        anchor.bottom + TOOLTIP_GAP + rect.height <= window.innerHeight - TOOLTIP_EDGE_MARGIN
      const fitsAbove = anchor.top - TOOLTIP_GAP - rect.height >= TOOLTIP_EDGE_MARGIN
      if (placement === 'bottom' && !fitsBelow && fitsAbove) setPlacement('top')
      if (placement === 'top' && !fitsAbove && fitsBelow) setPlacement('bottom')
    }
    fit()
    window.addEventListener('resize', fit)
    return () => {
      window.removeEventListener('resize', fit)
    }
  }, [anchor, content, placement])

  return (
    <>
      {cloneElement(children, {
        ref: mergedRef,
        onMouseEnter: (event) => {
          children.props.onMouseEnter?.(event)
          triggersRef.current.hover = true
          showAfterHoverDelay()
        },
        onMouseLeave: (event) => {
          children.props.onMouseLeave?.(event)
          triggersRef.current.hover = false
          hide()
        },
        onFocus: (event) => {
          children.props.onFocus?.(event)
          triggersRef.current.focus = true
          cancelShow()
          show()
        },
        onBlur: (event) => {
          children.props.onBlur?.(event)
          triggersRef.current.focus = false
          hide()
        },
      })}
      {anchor !== null && (
        <span
          ref={bubbleRef}
          role="tooltip"
          data-side={placement}
          style={{
            position: 'fixed',
            zIndex: 100,
            transform: TOOLTIP_TRANSFORM[placement],
            background: 'rgba(0, 0, 0, 0.88)',
            color: '#fff',
            fontSize: 11,
            lineHeight: '16px',
            padding: '3px 7px',
            borderRadius: 4,
            whiteSpace: 'pre-line',
            maxWidth: '50vw',
            overflowWrap: 'break-word',
            pointerEvents: 'none',
          }}
        >
          {content}
        </span>
      )}
    </>
  )
}

interface JsonTreeProps {
  data: unknown
  label?: string
  className?: string
}

export function JsonTree({ data, label, className }: JsonTreeProps) {
  return (
    <details className={className} open>
      {label !== undefined && <summary>{label}</summary>}
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  )
}

interface MarkdownTextProps {
  text: string
}

export function MarkdownText({ text }: MarkdownTextProps) {
  return (
    <div className="trajectory-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

/**
 * Bounded Markdown-to-plain-text projection for ledger previews.
 * @param text - Untrusted message, reasoning, payload, or result text.
 * @returns Markdown markup removed and whitespace collapsed.
 */
export function extractMarkdownPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, (match) => match.replace(/```[a-zA-Z0-9_-]*\n?|```/g, ''))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|\*|~~)/g, '')
}
