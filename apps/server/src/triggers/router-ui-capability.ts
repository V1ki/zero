import { randomUUID } from 'node:crypto'
import {
  ROUTER_A2UI_CATALOG,
  ROUTER_A2UI_VERSION,
  type RouterGeneratedUI,
  type RouterSurfaceMessages,
  readRouterSurface,
} from '@zero-os/shared'
import { TriggerAgentError } from './event-agent'
import { capability, routerInteger, routerText } from './router-capabilities'

/** The Agent supplies the component tree and operations. This adapter only validates the catalog. */
export function createRouterUICapability() {
  let ui: RouterGeneratedUI | undefined
  return {
    get: () => ui,
    tool: capability(
      'present_ui',
      '为本轮生成 A2UI 界面。你自行组织内容、层级和操作。支持 Column/Row {id,component,children:string[]}、Text {id,component,text:string或{path:"/key"},variant?:h3|body|caption}、TextField {id,component,label,value:{path:"/key"},variant?:shortText|longText}、Button {id,component,child:string,action:{event:{name:"router_input",context?:{field:{path:"/key"}}}},variant?:primary}；必须有 root 根节点。data 是字符串值对象。需要填写内容时，为输入绑定的数据提供初始值，在相应按钮的 event.context 声明必填字段及其输入路径。actions 用按钮 id 映射 {instruction,matterId?,matterVersion?}。instruction 必须与按钮可见文字完全一致，背景由事项及对话提供。按钮点击后重新进入 Router，不直接执行工具；有事项的操作必须绑定当前版本。使用真实回执组织界面，不伪造证据。',
      {
        components: { type: 'array', items: { type: 'object' }, minItems: 1 },
        data: { type: 'object', additionalProperties: { type: 'string' } },
        actions: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              instruction: { type: 'string' },
              matterId: { type: 'string' },
              matterVersion: { type: 'integer' },
            },
            required: ['instruction'],
            additionalProperties: false,
          },
        },
      },
      (args) => {
        const surfaceId = `router-generated-${randomUUID()}`
        const candidate = [
          {
            version: ROUTER_A2UI_VERSION,
            createSurface: { surfaceId, catalogId: ROUTER_A2UI_CATALOG },
          },
          {
            version: ROUTER_A2UI_VERSION,
            updateComponents: { surfaceId, components: args.components },
          },
          {
            version: ROUTER_A2UI_VERSION,
            updateDataModel: { surfaceId, path: '/', value: args.data },
          },
        ]
        const surface = readRouterSurface(candidate)
        if (!surface)
          throw new TriggerAgentError(
            'A2UI 结构不符合目录：检查 root、组件类型、唯一标识、引用和数据绑定。',
          )
        if (!args.actions || typeof args.actions !== 'object' || Array.isArray(args.actions))
          throw new TriggerAgentError('actions 必须是对象。')
        const actions: RouterGeneratedUI['actions'] = {}
        const buttons = [...surface.nodes.values()].filter((node) => node.component === 'Button')
        for (const [id, raw] of Object.entries(args.actions)) {
          if (
            !raw ||
            typeof raw !== 'object' ||
            Array.isArray(raw) ||
            Object.keys(raw).some(
              (key) => !['instruction', 'matterId', 'matterVersion'].includes(key),
            )
          )
            throw new TriggerAgentError('界面操作字段无效。')
          const item = raw as Record<string, unknown>
          if (!buttons.some((button) => button.id === id))
            throw new TriggerAgentError('每个操作都必须有可见按钮。')
          if ((item.matterId === undefined) !== (item.matterVersion === undefined))
            throw new TriggerAgentError('事项操作必须同时给出标识和版本。')
          actions[id] = {
            instruction: routerText(item.instruction, 2000),
            ...(item.matterId !== undefined && {
              matterId: routerText(item.matterId, 100),
              matterVersion: routerInteger(item.matterVersion),
            }),
          }
        }
        for (const button of buttons) {
          if (button.component !== 'Button') continue
          if (button.action.event.name !== 'router_input' || !actions[button.id])
            throw new TriggerAgentError('生成的按钮只能通过已声明的操作回到 Router。')
          const label = surface.nodes.get(button.child)
          const visible =
            label?.component === 'Text'
              ? typeof label.text === 'string'
                ? label.text
                : surface.values.get(label.text.path.slice(1))
              : null
          if (label?.component === 'Text' && typeof label.text !== 'string') {
            const path = label.text.path
            if (
              [...surface.nodes.values()].some(
                (c) => c.component === 'TextField' && c.value.path === path,
              )
            )
              throw new TriggerAgentError('按钮文字必须固定，不能使用可编辑的输入。')
          }
          if (visible !== actions[button.id].instruction)
            throw new TriggerAgentError(
              '操作 instruction 必须与按钮上可见的文字完全一致；事项背景通过上下文传递，不放入隐藏指令。',
            )
        }
        ui = { messages: candidate as RouterSurfaceMessages, actions }
        return { status: 'prepared', surfaceId, actions: Object.keys(actions) }
      },
    ),
  }
}
