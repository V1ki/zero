import {
  ROUTER_A2UI_VERSION,
  type RouterActionName,
  type RouterSurfaceAction,
  type RouterSurfaceMessages,
  readRouterSurface,
  routerActionInputError,
} from '@zero-os/shared'
import { type ReactNode, useState } from 'react'
import { RouterMessage } from './RouterMessage'
import './RouterSurface.css'

type SurfaceProps = {
  messages: RouterSurfaceMessages
  onAction(event: RouterSurfaceAction): void
  disabled?: boolean
  actionSlot?: { only: RouterActionName } | { omit: RouterActionName }
}
export function RouterSurface(props: SurfaceProps) {
  return <SurfaceForm key={props.messages[0]?.createSurface?.surfaceId} {...props} />
}
function SurfaceForm({ messages, onAction, disabled = false, actionSlot }: SurfaceProps) {
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState('')
  const surface = readRouterSurface(messages)
  if (!surface)
    return actionSlot && 'only' in actionSlot ? null : (
      <p role="alert">这张交互卡片无法显示。你可以在下方继续对话。</p>
    )
  const { nodes, values, surfaceId } = surface

  const currentValue = (path: string) => edits[path] ?? values.get(path.slice(1)) ?? ''
  function render(id: string, inButton = false): ReactNode {
    const c = nodes.get(id)
    if (!c) return null
    if (c.component === 'Text') {
      const text = typeof c.text === 'string' ? c.text : currentValue(c.text.path)
      if (inButton) return <span key={id}>{text}</span>
      if (c.variant === 'h3') return <h3 key={id}>{text}</h3>
      return (
        <div key={id} className={c.variant === 'caption' ? 'router-surface-caption' : undefined}>
          <RouterMessage text={text} />
        </div>
      )
    }
    if (c.component === 'TextField') {
      const path = c.value.path
      const control = {
        value: currentValue(path),
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
          const value = event.target.value
          setEdits((previous) => ({ ...previous, [path]: value }))
          setProblem('')
        },
      }
      return (
        <label key={id} className="router-surface-field">
          {c.label}
          {c.variant === 'longText' ? (
            <textarea {...control} />
          ) : (
            <input type="text" {...control} />
          )}
        </label>
      )
    }
    if (c.component === 'Button') {
      const { name } = c.action.event
      if (actionSlot && 'omit' in actionSlot && actionSlot.omit === name) return null
      return (
        <button
          type="button"
          key={id}
          disabled={disabled}
          data-variant={c.variant}
          onClick={() => {
            const context = Object.fromEntries(
              Object.entries(c.action.event.context ?? {}).map(([key, binding]) => [
                key,
                currentValue(binding.path),
              ]),
            )
            const error = routerActionInputError(c, context)
            if (error) {
              setProblem(error)
              return
            }
            setProblem('')
            onAction({
              version: ROUTER_A2UI_VERSION,
              action: {
                name,
                surfaceId,
                sourceComponentId: id,
                timestamp: new Date().toISOString(),
                context,
              },
            })
          }}
        >
          {render(c.child, true)}
        </button>
      )
    }
    return (
      <div
        className={c.component === 'Row' ? 'router-surface-row' : 'router-surface-column'}
        key={id}
      >
        {c.children.map((child) => render(child, inButton))}
      </div>
    )
  }
  if (actionSlot && 'only' in actionSlot) {
    const button = [...nodes.values()].find(
      (c) => c.component === 'Button' && c.action.event.name === actionSlot.only,
    )
    return button ? <span className="router-surface-row">{render(button.id)}</span> : null
  }
  return (
    <section className="router-a2ui" aria-label="交互卡片" data-surface-id={surfaceId}>
      {render('root')}
      {problem && <p role="alert">{problem}</p>}
    </section>
  )
}
