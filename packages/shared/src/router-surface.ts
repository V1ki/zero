// A complete Router surface travels as a snapshot of A2UI v0.9.1 messages over local HTTP.
// The official basic catalog declares this ID in specification/v0_9_1/catalogs/basic/catalog.json.
export const ROUTER_A2UI_VERSION = 'v0.9.1'
export const ROUTER_A2UI_CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'
export type RouterActionName =
  | 'explain_route'
  | 'suggest_next'
  | 'process_event'
  | 'inspect_github'
  | 'compare_runs'
  | 'choose_option'
export type RouterSurfaceComponent =
  | { id: string; component: 'Column' | 'Row'; children: string[] }
  | {
      id: string
      component: 'Text'
      text: string | { path: string }
      variant?: 'h3' | 'body' | 'caption'
    }
  | {
      id: string
      component: 'Button'
      variant?: 'primary'
      child: string
      action: { event: { name: RouterActionName } }
    }

type Version = typeof ROUTER_A2UI_VERSION
export type RouterSurfaceMessages = [
  { version: Version; createSurface: { surfaceId: string; catalogId: typeof ROUTER_A2UI_CATALOG } },
  {
    version: Version
    updateComponents: { surfaceId: string; components: RouterSurfaceComponent[] }
  },
  {
    version: Version
    updateDataModel: { surfaceId: string; path: '/'; value: Record<string, string> }
  },
]

export interface RouterSurfaceAction {
  version: Version
  action: {
    name: RouterActionName
    surfaceId: string
    sourceComponentId: string
    timestamp: string
    context: Record<string, never>
  }
}

const identifier = /^[A-Za-z][A-Za-z0-9_-]{0,80}$/
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fields(value: unknown, keys: string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).every((key) => keys.includes(key))
}
function id(value: unknown): value is string {
  return typeof value === 'string' && identifier.test(value)
}
function name(value: unknown): value is RouterActionName {
  return (
    value === 'explain_route' ||
    value === 'suggest_next' ||
    value === 'process_event' ||
    value === 'inspect_github' ||
    value === 'compare_runs' ||
    value === 'choose_option'
  )
}

function supportedComponent(c: unknown): c is RouterSurfaceComponent {
  if (!record(c) || !id(c.id)) return false
  if (c.component === 'Column' || c.component === 'Row')
    return (
      fields(c, ['id', 'component', 'children']) &&
      Array.isArray(c.children) &&
      c.children.length <= 64 &&
      c.children.every(id)
    )
  if (c.component === 'Text')
    return (
      fields(c, ['id', 'component', 'text', 'variant']) &&
      (c.variant === undefined ||
        c.variant === 'body' ||
        c.variant === 'h3' ||
        c.variant === 'caption') &&
      (typeof c.text === 'string' ||
        (fields(c.text, ['path']) &&
          typeof c.text.path === 'string' &&
          /^\/[A-Za-z][\w-]{0,80}$/.test(c.text.path)))
    )
  return (
    c.component === 'Button' &&
    fields(c, ['id', 'component', 'child', 'action', 'variant']) &&
    (c.variant === undefined || c.variant === 'primary') &&
    id(c.child) &&
    fields(c.action, ['event']) &&
    fields(c.action.event, ['name']) &&
    name(c.action.event.name)
  )
}

// Accept only our catalog subset. Never fetch a catalog, execute expressions, or render unknown components.
export function readRouterSurface(messages: unknown) {
  if (!Array.isArray(messages) || messages.length !== 3) return null
  const [create, components, data] = messages
  if (
    !fields(create, ['version', 'createSurface']) ||
    !fields(create.createSurface, ['surfaceId', 'catalogId']) ||
    !fields(components, ['version', 'updateComponents']) ||
    !fields(components.updateComponents, ['surfaceId', 'components']) ||
    !fields(data, ['version', 'updateDataModel']) ||
    !fields(data.updateDataModel, ['surfaceId', 'path', 'value'])
  )
    return null
  const { surfaceId, catalogId } = create.createSurface
  const update = components.updateComponents
  const model = data.updateDataModel
  if (
    ![create, components, data].every((m) => m.version === ROUTER_A2UI_VERSION) ||
    !id(surfaceId) ||
    catalogId !== ROUTER_A2UI_CATALOG ||
    update.surfaceId !== surfaceId ||
    model.surfaceId !== surfaceId ||
    model.path !== '/' ||
    !record(model.value) ||
    !Array.isArray(update.components) ||
    update.components.length > 96
  )
    return null

  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(model.value)) {
    if (!id(key) || typeof value !== 'string') return null
    values.set(key, value)
  }
  const nodes = new Map<string, RouterSurfaceComponent>()
  for (const c of update.components) {
    if (!supportedComponent(c) || nodes.has(c.id)) return null
    nodes.set(c.id, c)
  }
  const seen = new Set<string>()
  function visit(key: string): boolean {
    const c = nodes.get(key)
    if (!c || seen.has(key)) return false
    seen.add(key)
    if (c.component === 'Text')
      return typeof c.text === 'string' || values.has(c.text.path.slice(1))
    if (c.component === 'Button') return nodes.get(c.child)?.component === 'Text' && visit(c.child)
    return c.children.every(visit)
  }
  return visit('root') && seen.size === nodes.size ? { surfaceId, nodes, values } : null
}

export function isRouterSurfaceAction(raw: unknown): raw is RouterSurfaceAction {
  if (
    !fields(raw, ['version', 'action']) ||
    raw.version !== ROUTER_A2UI_VERSION ||
    !fields(raw.action, ['name', 'surfaceId', 'sourceComponentId', 'timestamp', 'context'])
  )
    return false
  const action = raw.action
  if (
    !name(action.name) ||
    !id(action.surfaceId) ||
    // A decision carries one button per option; the server reads the option from its own record.
    (action.name === 'choose_option'
      ? !/^btn-choose_option-[0-2]$/.test(String(action.sourceComponentId))
      : action.sourceComponentId !== `btn-${action.name}`) ||
    !fields(action.context, []) ||
    typeof action.timestamp !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(action.timestamp) ||
    !Number.isFinite(Date.parse(action.timestamp))
  )
    return false
  return true
}

export function matchesRouterSurfaceAction(
  messages: RouterSurfaceMessages,
  raw: unknown,
): raw is RouterSurfaceAction {
  if (!isRouterSurfaceAction(raw)) return false
  const { action } = raw
  const surface = readRouterSurface(messages)
  if (!surface || action.surfaceId !== surface.surfaceId) return false
  const node = surface.nodes.get(action.sourceComponentId)
  return node?.component === 'Button' && node.action.event.name === action.name
}
