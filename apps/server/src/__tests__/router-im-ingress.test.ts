import { expect, mock, test } from 'bun:test'
import type { ProviderAdapter } from '@zero-os/model'
import { MetricsDB, TriggerStore } from '@zero-os/observe'
import type { MandatePlatform } from '@zero-os/shared'
import { createRuntimeChannelMessageHandler } from '../runtime/channel-runtime/runtime-common'
import { discardedEvents } from '../triggers/__tests__/router-log-fixture'
import { createRouterAgent } from '../triggers/router-agent'
import { RouterWorkspaceService } from '../triggers/router-workspace'
import { TriggerRoutingRuntime } from '../triggers/routing-runtime'
import { createTaskBridge } from '../triggers/task-bridge'
import {
  createAssistantTextMessage,
  createDefaultMessageHandlerDeps,
  createIncomingMessage,
} from './message-handler-harness'

test('selected bots route ordinary DMs to their own Router loop while other bots keep the ordinary Agent', async () => {
  const store = new TriggerStore(':memory:')
  const metrics = MetricsDB.createInMemory()
  const personalBots = { weixin: 'personal', dingtalk: 'work', feishu: 'research' }
  const platforms: MandatePlatform[] = ['weixin', 'dingtalk', 'feishu']
  const targets = platforms.map((platform) => ({
    platform,
    channelId: personalBots[platform],
    peerId: 'private-peer',
    operatorId: 'private-peer',
    label: personalBots[platform],
  }))
  const forbid = async () => {
    throw new Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: forbid,
    weixin: { listTargets: () => [], send: forbid },
    personal: {
      listPersonalBots: () => targets.map((target) => ({ ...target, online: true })),
      listPersonalTargets: () => targets,
      listPersonalDirectTargets: () => targets,
      sendPersonal: forbid,
    },
  })
  const modelRequests: Parameters<ProviderAdapter['complete']>[0][] = []
  const adapter: ProviderAdapter = {
    apiType: 'fixture',
    healthCheck: async () => true,
    stream() {
      throw new Error('Unexpected streaming')
    },
    complete: async (request) => {
      modelRequests.push(request)
      return {
        id: 'result',
        model: 'fixture',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Router 回复' }],
        usage: { input: 1, output: 1 },
      }
    },
  }
  const workspace = new RouterWorkspaceService(
    store,
    routing,
    createRouterAgent({
      modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
      secretFilter: { filter: (text) => text },
      sessionEvents: discardedEvents,
    }),
  )
  const bridge = createTaskBridge({
    store,
    agent: forbid,
    isLiveTarget: () => false,
    isPersonalTarget: (target) => routing.isPersonalTarget(target),
    personalDialog: {
      authorize: (target) => routing.claimRouterImTarget(target),
      handle: (input, authorized) => workspace.handleIm(input, authorized),
    },
  })
  const reply = mock(async (_peer: string, _text: string, _messageId?: string | number) => {})
  const channelAdapter = { reply, showTyping: async () => null }
  const ordinary = mock(async () => [createAssistantTextMessage('普通 Agent 会话的资料')])
  const deps = createDefaultMessageHandlerDeps(
    {
      data: { id: 'ordinary-session' },
      isAgentInitialized: () => true,
      setChannelCapabilities: () => {},
      initAgent: () => {},
      handleMessage: ordinary,
    },
    channelAdapter,
  )
  async function receive(
    platform: MandatePlatform,
    text: string,
    id: string,
    bot = personalBots[platform],
  ) {
    const handler = createRuntimeChannelMessageHandler(
      {
        ...deps,
        zeroDir: '',
        metrics,
        channels: new Map(),
        channelAdapters: new Map(),
        getTaskBridge: () => bridge,
        registerFeishuStreamingSessionSet: () => {},
        heartbeat: { write() {} },
      },
      {
        channelName: bot,
        channelType: platform,
        agentName: bot,
        channelCapabilities: {},
        channelAdapter,
      },
    )
    await handler(
      createIncomingMessage({
        channelType: platform,
        senderId: 'private-peer',
        content: text,
        metadata: {
          chatId: 'private-peer',
          messageId: id,
          routerDirect: true,
          ...(platform === 'dingtalk'
            ? { conversationType: '1' }
            : { chatType: platform === 'feishu' ? 'p2p' : 'dm' }),
        },
      }),
    )
  }
  try {
    workspace.start()
    const { settings, revision } = routing.getConfig()
    routing.saveConfig({ ...settings, personalBots }, revision)
    await workspace.message('general', 'web-only', '只在网页里讨论的资料')
    await receive('weixin', '旧会话问题', 'ordinary-msg', 'unselected')
    expect(ordinary).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls[0]?.[1]).toBe('普通 Agent 会话的资料')

    const query = '看看我的 GitHub 里面的仓库'
    await receive('weixin', query, 'same-message-id')
    await receive('weixin', query, 'same-message-id')
    await receive('dingtalk', '钉钉的通知设置', 'same-message-id')
    await receive('feishu', '飞书的通知设置', 'same-message-id')
    await receive('weixin', '上一条问了什么', 'follow-up')

    expect(ordinary).toHaveBeenCalledTimes(1)
    expect(reply.mock.calls.slice(1).map(([, text]) => text)).toEqual(Array(4).fill('Router 回复'))
    expect(modelRequests).toHaveLength(5)
    for (const request of modelRequests.slice(1)) {
      const toolNames = request.tools?.map((tool) => tool.name) ?? []
      expect(toolNames).toContain('preview_current_route')
      expect(toolNames).not.toContain('bash')
      const sent = JSON.stringify(request.messages)
      expect(sent).not.toContain('普通 Agent 会话的资料')
      expect(sent).not.toContain('只在网页里讨论的资料')
    }
    expect(JSON.stringify(modelRequests[1].messages)).toContain(query)
    expect(JSON.stringify(modelRequests[2].messages)).not.toContain(query)
    expect(JSON.stringify(modelRequests[3].messages)).not.toContain(query)
    const followUp = JSON.stringify(modelRequests[4].messages)
    expect(followUp).toContain(query)
    expect(followUp).not.toContain('钉钉的通知设置')
    expect(followUp).not.toContain('飞书的通知设置')
    expect(workspace.get('general').turns.map((turn) => turn.question)).toEqual([
      '只在网页里讨论的资料',
    ])
  } finally {
    await workspace.close()
    await routing.close()
    await bridge.close()
    store.close()
    metrics.close()
  }
})
