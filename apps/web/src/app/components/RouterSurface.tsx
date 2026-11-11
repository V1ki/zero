import {
  ROUTER_A2UI_VERSION,
  type RouterSurfaceAction,
  type RouterSurfaceMessages,
  readRouterSurface,
} from '@zero-os/shared'
import type { ReactNode } from 'react'
import './RouterSurface.css'

export function RouterSurface({
  messages,
  onAction,
  disabled = false,
}: {
  messages: RouterSurfaceMessages
  onAction(event: RouterSurfaceAction): void
  disabled?: boolean
}) {
  const surface = readRouterSurface(messages)
  if (!surface) return <p role="alert">这张交互卡片无法显示。你可以在下方继续对话。</p>
  const { nodes, values, surfaceId } = surface

  function render(id: string): ReactNode {
    const c = nodes.get(id)
    if (!c) return null
    if (c.component === 'Text') {
      const text = typeof c.text === 'string' ? c.text : values.get(c.text.path.slice(1))
      if (c.variant === 'h3') return <h3 key={id}>{text}</h3>
      return (
        <span key={id} className={c.variant === 'caption' ? 'router-surface-caption' : undefined}>
          {text}
        </span>
      )
    }
    if (c.component === 'Button') {
      const { name } = c.action.event
      return (
        <button
          type="button"
          key={id}
          disabled={disabled}
          data-variant={c.variant}
          onClick={() =>
            onAction({
              version: ROUTER_A2UI_VERSION,
              action: {
                name,
                surfaceId,
                sourceComponentId: id,
                timestamp: new Date().toISOString(),
                context: {},
              },
            })
          }
        >
          {render(c.child)}
        </button>
      )
    }
    return (
      <div
        className={c.component === 'Row' ? 'router-surface-row' : 'router-surface-column'}
        key={id}
      >
        {c.children.map(render)}
      </div>
    )
  }
  return (
    <section className="router-a2ui" aria-label="交互卡片" data-surface-id={surfaceId}>
      {render('root')}
    </section>
  )
}
