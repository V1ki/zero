// A complete Router surface travels as a snapshot of A2UI v0.9.1 messages over local HTTP.
// The official basic catalog declares this ID in specification/v0_9_1/catalogs/basic/catalog.json.
export const ROUTER_A2UI_VERSION = 'v0.9.1'
export const ROUTER_A2UI_CATALOG = 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'
export type RouterActionName =
  | 'router_input'
  | 'explain_route'
  | 'suggest_next'
  | 'process_event'
  | 'work_on_event'
  | 'inspect_github'
  | 'compare_runs'
  | 'find_related_issues'
  | 'confirm_mandate'
  | 'apply_preference'
  | 'prepare_reminder'
  | 'send_reminder'
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
      component: 'TextField'
      label: string
      value: { path: string }
      variant?: 'shortText' | 'longText'
    }
  | {
      id: string
      component: 'Button'
      variant?: 'primary'
      child: string
      action: { event: { name: RouterActionName; context?: Record<string, { path: string }> } }
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
    context: Record<string, string>
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
function dataPath(value: unknown): value is { path: string } {
  return (
    fields(value, ['path']) &&
    typeof value.path === 'string' &&
    value.path.startsWith('/') &&
    id(value.path.slice(1))
  )
}
function name(value: unknown): value is RouterActionName {
  return (
    value === 'router_input' ||
    value === 'explain_route' ||
    value === 'suggest_next' ||
    value === 'process_event' ||
    value === 'work_on_event' ||
    value === 'inspect_github' ||
    value === 'compare_runs' ||
    value === 'find_related_issues' ||
    value === 'confirm_mandate' ||
    value === 'prepare_reminder' ||
    value === 'send_reminder' ||
    value === 'apply_preference'
  )
}

export interface RouterGeneratedUI {
  messages: RouterSurfaceMessages
  actions: Record<string, { instruction: string; matterId?: string; matterVersion?: number }>
}

function supportedComponent(c: unknown): c is RouterSurfaceComponent {
  if (!record(c) || !id(c.id)) return false
  if (c.component === 'Column' || c.component === 'Row')
    return (
      fields(c, ['id', 'component', 'children']) &&
      Array.isArray(c.children) &&
      c.children.every(id)
    )
  if (c.component === 'Text')
    return (
      fields(c, ['id', 'component', 'text', 'variant']) &&
      (c.variant === undefined ||
        c.variant === 'body' ||
        c.variant === 'h3' ||
        c.variant === 'caption') &&
      (typeof c.text === 'string' || dataPath(c.text))
    )
  if (c.component === 'TextField')
    return (
      fields(c, ['id', 'component', 'label', 'value', 'variant']) &&
      typeof c.label === 'string' &&
      !!c.label.trim() &&
      dataPath(c.value) &&
      (c.variant === undefined || c.variant === 'shortText' || c.variant === 'longText')
    )
  return (
    c.component === 'Button' &&
    fields(c, ['id', 'component', 'child', 'action', 'variant']) &&
    (c.variant === undefined || c.variant === 'primary') &&
    id(c.child) &&
    fields(c.action, ['event']) &&
    fields(c.action.event, ['name', 'context']) &&
    name(c.action.event.name) &&
    (c.action.event.context === undefined ||
      (c.action.event.name === 'router_input' &&
        record(c.action.event.context) &&
        Object.entries(c.action.event.context).every(([key, value]) => id(key) && dataPath(value))))
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
    !Array.isArray(update.components)
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
  const editablePaths = new Set(
    [...nodes.values()].filter((c) => c.component === 'TextField').map((c) => c.value.path),
  )
  const seen = new Set<string>()
  const pending = ['root']
  while (pending.length) {
    const key = pending.pop()!
    const c = nodes.get(key)
    if (!c || seen.has(key)) return null
    seen.add(key)
    if (c.component === 'Text') {
      if (typeof c.text !== 'string' && !values.has(c.text.path.slice(1))) return null
    } else if (c.component === 'TextField') {
      if (!values.has(c.value.path.slice(1))) return null
    } else if (c.component === 'Button') {
      if (
        nodes.get(c.child)?.component !== 'Text' ||
        !Object.values(c.action.event.context ?? {}).every((binding) =>
          editablePaths.has(binding.path),
        )
      )
        return null
      pending.push(c.child)
    } else {
      for (const child of c.children) pending.push(child)
    }
  }
  return seen.size === nodes.size ? { surfaceId, nodes, values } : null
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
    (action.name === 'router_input'
      ? !id(action.sourceComponentId)
      : action.name === 'work_on_event'
        ? typeof action.sourceComponentId !== 'string' ||
          !/^btn-work_on_event-[1-9]\d{0,14}$/u.test(action.sourceComponentId)
        : action.sourceComponentId !== `btn-${action.name}`) ||
    !(action.name === 'router_input'
      ? record(action.context) &&
        Object.entries(action.context).every(([key, value]) => id(key) && typeof value === 'string')
      : fields(action.context, [])) ||
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
  return (
    node?.component === 'Button' &&
    node.action.event.name === action.name &&
    !routerActionInputError(node, action.context)
  )
}

export function routerActionInputError(
  button: Extract<RouterSurfaceComponent, { component: 'Button' }>,
  context: Record<string, string>,
): string | undefined {
  const keys = Object.keys(button.action.event.context ?? {})
  if (Object.keys(context).some((key) => !keys.includes(key))) return '提交的字段与原卡片不符。'
  if (keys.some((key) => !Object.hasOwn(context, key) || !context[key].trim()))
    return '请填写此操作需要的内容。'
}
