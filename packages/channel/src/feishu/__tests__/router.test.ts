import { describe, expect, mock, spyOn, test } from 'bun:test'
import * as lark from '@larksuiteoapi/node-sdk'
import { FeishuChannel, type FeishuChannelFactories } from '../index'
import { FeishuRouterDelivery } from '../router'

const payload = {
  id: 'work-19',
  digest: false,
  entries: [{ taskId: 19, title: '检查构建', summary: '<at id=all>检查结果' }],
}
const signal = () => new AbortController().signal
const appId = 'cli_test'

async function harness(botAppId = appId) {
  const create = mock(
    async (_input: unknown): Promise<unknown> => ({ code: 0, data: { message_id: 'om_native' } }),
  )
  const access = mock(async (_input: unknown) => ({ code: 0, data: { auth_result: true } }))
  const scopes = mock(async () => ({
    code: 0,
    data: {
      scopes: [{ scope_name: 'docx:document:write_only', grant_status: 1, scope_type: 'tenant' }],
    },
  }))
  const append = mock(
    async (input: { params: { client_token: string } }): Promise<unknown> => ({
      code: 0,
      data: { client_token: input.params.client_token, children: [{ block_id: 'docxBlock' }] },
    }),
  )
  let dispatcher: lark.EventDispatcher
  const channel = new FeishuChannel({ name: 'office', appId: botAppId, appSecret: 'fixture' }, {
    createClient: () =>
      ({
        im: { message: { create, reply: create } },
        application: { scope: { list: scopes } },
        drive: { permissionMember: { auth: access } },
        docx: { documentBlockChildren: { create: append } },
      }) as unknown as lark.Client,
    createEventDispatcher: (options) => new lark.EventDispatcher(options),
    createWsClient: () => ({
      start: async ({ eventDispatcher }) => {
        dispatcher = eventDispatcher
      },
      close() {},
    }),
  } satisfies FeishuChannelFactories)
  await channel.start()
  // The SDK invokes EventDispatcher after WebSocket-authenticated frame decoding.
  const invoke = (input: unknown) => dispatcher.invoke(input, { needCheck: false })
  return { channel, create, access, scopes, append, invoke }
}

function actionEvent() {
  return {
    schema: '2.0',
    header: {
      app_id: appId,
      tenant_key: 'tenant1',
      event_type: 'card.action.trigger',
      event_id: 'event_a',
    },
    event: {
      host: 'im_message',
      context: { open_chat_id: 'oc_room', open_message_id: 'om_native' },
      operator: { tenant_key: 'tenant1', open_id: 'ou_user' },
      action: {
        tag: 'button',
        value: { source: 'zero_router', action: 'ack', taskId: 19, digest: false },
      },
    },
  }
}

describe('Feishu native Router', () => {
  test('a long Markdown reply retains links, emphasis and the ending across distinct cards', async () => {
    const h = await harness()
    try {
      const start = '**只列文档** · [#145](https://github.com/example/project/pull/145)'
      const end = '尚未合并，须更新原分支。'
      await h.channel.router.replyMarkdown(
        'om_docs',
        [start, '资料。'.repeat(5500), end].join('\n\n'),
      )
      const data = h.create.mock.calls.map(
        ([r]) => (r as { data: { uuid: string; content: string } }).data,
      )
      expect(data.length).toBeGreaterThan(1)
      expect(new Set(data.map((d) => d.uuid)).size).toBe(data.length)
      const content = data.map((d) => JSON.parse(d.content).body.elements[0].content).join('\n')
      expect(content).toContain(start)
      expect(content.endsWith(end)).toBe(true)
    } finally {
      await h.channel.stop()
    }
  })
  test('a PR card is one reply with a stable key and no fallback after an uncertain receipt', async () => {
    const h = await harness()
    const send = (allowed: boolean) =>
      h.channel.router.replyCard('om_incoming', '{"schema":"2.0"}', () => allowed)
    try {
      await expect(send(false)).rejects.toThrow()
      expect(h.create).not.toHaveBeenCalled()
      await send(true)
      const [first] = h.create.mock.calls[0]
      expect(first).toMatchObject({
        path: { message_id: 'om_incoming' },
        data: { msg_type: 'interactive' },
      })
      h.create.mockImplementationOnce(async () => ({ code: 0, data: {} }))
      await expect(send(true)).rejects.toThrow('not confirmed')
      expect(h.create).toHaveBeenCalledTimes(2)
      expect(h.create.mock.calls[1][0]).toEqual(first)
    } finally {
      await h.channel.stop()
    }
  })
  test('sends manual text without an inbox entry and namespaces the stable write key by bot and delivery', async () => {
    const first = await harness()
    const other = await harness('cli_other')
    try {
      const body = '处理 DeepSeek 的充值'
      for (const h of [first, other]) {
        const send = (id: string) =>
          h.channel.router.sendDirectReminder('oc_private', id, body, signal(), () => true)
        expect((await send('')).status).toBe('rejected')
        expect(h.create).not.toHaveBeenCalled()
        expect((await send('same-turn')).status).toBe('accepted')
        expect((await send('same-turn')).status).toBe('accepted')
        expect((await send('next-turn')).status).toBe('accepted')
      }
      const writes = (h: typeof first) =>
        h.create.mock.calls.map(
          ([request]) => (request as { data: { uuid: string; content: string } }).data,
        )
      const [a, again, next] = writes(first)
      expect(JSON.parse(a.content)).toEqual({ text: body })
      expect(a.uuid).toHaveLength(36)
      expect(again.uuid).toBe(a.uuid)
      expect(next.uuid).not.toBe(a.uuid)
      expect(writes(other)[0].uuid).not.toBe(a.uuid)
    } finally {
      await first.channel.stop()
      await other.channel.stop()
    }
  })

  test('sends a personal inbox reminder as literal text, with a stable UUID and no task action', async () => {
    const h = await harness()
    const body = 'ZeRo 监听 #17\n<at user_id="all">有人吗</at>'
    const send = (allowed: boolean) =>
      h.channel.router.sendListenerReminder('oc_room', 17, body, signal(), () => allowed)
    expect((await send(false)).status).toBe('rejected')
    expect(h.create).not.toHaveBeenCalled()
    expect(await send(true)).toEqual({ status: 'accepted', receipt: 'om_native' })
    const request = h.create.mock.calls[0]?.[0] as { data: { content: string; uuid: string } }
    expect(request).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_room', msg_type: 'text' },
    })
    expect(JSON.parse(request.data.content)).toEqual({ text: body.replace('<at', '＜at') })
    expect(request.data.uuid).toHaveLength(36)
    h.create.mockImplementationOnce(async () => ({ code: 0, data: {} }))
    expect((await send(true)).status).toBe('unknown')
    expect(h.create.mock.calls[1]?.[0]).toEqual(request)
    expect(h.create).toHaveBeenCalledTimes(2)
    await h.channel.stop()
  })

  test('keeps overflow task references distinct from legacy inbox numbers in digests', async () => {
    const h = await harness()
    const entries = Array.from({ length: 10 }, (_, i) => ({
      ...payload.entries[0],
      taskId: i + 20,
    }))
    await h.channel.router.send('oc_room', { ...payload, digest: true, entries }, signal())
    const request = h.create.mock.calls[0]?.[0] as { data: { content: string } }
    const card = JSON.parse(request.data.content)
    expect(card.body.elements.at(-2).text.content).toContain('#任务28、#任务29')
    expect(card.body.elements.at(-1).text.content).toContain('其他任务请替换编号')
    expect(card.body.elements.at(-1).text.content).toContain('「#任务20 确认」')
    expect(card.body.elements.at(-1).text.content).toContain('「#任务20 进展如何」')
    expect(
      card.body.elements.filter((item: { tag: string }) => item.tag === 'button'),
    ).toHaveLength(8)
    await h.channel.stop()
  })

  test('sends one targeted native card with a stable provider UUID, literal source text and an actionable receipt', async () => {
    const h = await harness()
    expect(await h.channel.router.send('oc_room', payload, signal())).toEqual({
      status: 'accepted',
      receipt: 'om_native',
    })
    await h.channel.router.send('oc_room', payload, signal())
    const first = h.create.mock.calls[0]?.[0] as {
      params: unknown
      data: { receive_id: string; msg_type: string; content: string; uuid: string }
    }
    expect(first.params).toEqual({ receive_id_type: 'chat_id' })
    expect(first.data).toMatchObject({ receive_id: 'oc_room', msg_type: 'interactive' })
    expect(first.data.uuid).toHaveLength(36)
    expect(h.create.mock.calls[1]?.[0]).toEqual(first)
    const view = JSON.parse(first.data.content)
    expect(view.body.elements[0].text.tag).toBe('plain_text')
    expect(view.body.elements.at(-1).text.content).toContain('「#任务19 确认」')
    expect(view.body.elements.at(-1).text.content).toContain('「#任务19 进展如何」')
    expect(view.body.elements[1].behaviors[0].value).toMatchObject({
      source: 'zero_router',
      taskId: 19,
      action: 'ack',
    })
  })

  test('an authorized native button returns a card update; invalid app, operator tenant, receipt, or retired connection cannot update it', async () => {
    const h = await harness()
    const ack = mock(
      async (v: { actorId: string; messageId: string; chatId: string; taskId: number }) =>
        v.actorId === 'ou_user' &&
        v.messageId === 'om_native' &&
        v.chatId === 'oc_room' &&
        v.taskId === 19,
    )
    h.channel.router.setActionHandler(ack)
    const result = await h.invoke(actionEvent())
    expect(result.toast.type).toBe('success')
    expect(result.card.data.header.title.content).toContain('已确认')
    expect(ack.mock.calls[0]?.[0]).toMatchObject({
      actorId: 'ou_user',
      messageId: 'om_native',
      chatId: 'oc_room',
      eventId: 'event_a',
      taskId: 19,
    })
    const wrongApp = actionEvent()
    wrongApp.header.app_id = 'cli_other'
    expect((await h.invoke(wrongApp)).toast.type).toBe('error')
    const wrongTenant = actionEvent()
    wrongTenant.event.operator.tenant_key = 'elsewhere'
    expect((await h.invoke(wrongTenant)).toast.type).toBe('error')
    expect(ack).toHaveBeenCalledTimes(1)
    const forwarded = actionEvent()
    forwarded.event.context.open_message_id = 'om_forwarded'
    expect((await h.invoke(forwarded)).toast.type).toBe('error')
    const digest = actionEvent()
    digest.event.action.value.digest = true
    expect((await h.invoke(digest)).card).toBeUndefined()
    await h.channel.stop()
    expect((await h.invoke(actionEvent())).toast.type).toBe('error')
    expect(ack).toHaveBeenCalledTimes(3)
  })

  test('callback diagnostics log fixed outcomes only for this app and Router card', async () => {
    const h = await harness()
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const otherApp = actionEvent()
      otherApp.header.app_id = 'another-app'
      await h.invoke(otherApp)
      const otherCard = actionEvent()
      otherCard.event.action.value.source = 'another-card'
      await h.invoke(otherCard)
      expect(log).not.toHaveBeenCalled()
      await h.invoke(actionEvent())
      const allow = mock(async () => false)
      h.channel.router.setActionHandler(allow)
      const malformed = actionEvent()
      malformed.event.host = 'private-unexpected-input'
      await h.invoke(malformed)
      await h.invoke(actionEvent())
      allow.mockResolvedValueOnce(true)
      await h.invoke(actionEvent())
      expect(log.mock.calls).toEqual(
        ['unavailable', 'invalid', 'denied', 'acknowledged'].flatMap((outcome) => [
          ['[FeishuChannel] Router card callback: received'],
          [`[FeishuChannel] Router card callback: ${outcome}`],
        ]),
      )
    } finally {
      log.mockRestore()
      await h.channel.stop()
    }
  })

  test('a rejected or uncertain notification does not prevent an independently authorized document append', async () => {
    const h = await harness()
    h.create.mockImplementationOnce(async () => {
      throw new Error('lost response')
    })
    expect((await h.channel.router.send('oc_room', payload, signal())).status).toBe('unknown')
    expect(h.append).not.toHaveBeenCalled()
    expect(await h.channel.router.probeDocument('doxcnTarget')).toMatchObject({ ok: true })
    expect(h.access.mock.calls[0]?.[0]).toEqual({
      path: { token: 'doxcnTarget' },
      params: { type: 'docx', action: 'edit' },
    })
    expect(h.append).not.toHaveBeenCalled()
    expect(await h.channel.router.archive('doxcnTarget', payload, signal())).toEqual({
      status: 'accepted',
      receipt: 'doxcnTarget#docxBlock',
    })
    expect(h.append.mock.calls[0]?.[0]).toMatchObject({
      path: { document_id: 'doxcnTarget', block_id: 'doxcnTarget' },
      data: { index: -1 },
    })
    await h.channel.router.archive('doxcnTarget', payload, signal())
    expect(h.append.mock.calls[0]?.[0].params.client_token).toBe(
      h.append.mock.calls[1]?.[0].params.client_token,
    )
    h.append.mockImplementationOnce(async () => ({ code: 0, data: { children: [] } }))
    expect((await h.channel.router.archive('doxcnTarget', payload, signal())).status).toBe(
      'unknown',
    )
    h.create.mockImplementationOnce(async () => ({ code: 230013 }))
    expect((await h.channel.router.send('oc_room', payload, signal())).status).toBe('rejected')
    h.create.mockImplementationOnce(async () => ({ code: 0, data: {} }))
    expect((await h.channel.router.send('oc_room', payload, signal())).status).toBe('unknown')
    expect(h.create).toHaveBeenCalledTimes(3)
  })

  test('revocation while checking the document ACL prevents the append', async () => {
    const h = await harness()
    let authorized = true
    h.access.mockImplementationOnce(async () => {
      authorized = false
      return { code: 0, data: { auth_result: true } }
    })
    expect(
      (await h.channel.router.archive('doxcnTarget', payload, signal(), () => authorized)).status,
    ).toBe('rejected')
    expect(h.append).not.toHaveBeenCalled()
    await h.channel.stop()
  })

  const kinds = ['task card', 'personal reminder']
  test.each(kinds)('rechecks delayed %s dispatch after SDK token retrieval', async (kind) => {
    let client: lark.Client
    const id = `test-router-dispatch-${crypto.randomUUID()}`
    const router = new FeishuRouterDelivery(() => client, id)
    const tokenStarted = Promise.withResolvers<void>()
    const releaseToken = Promise.withResolvers<void>()
    let authorized = true
    let tokenRequests = 0
    const sent: string[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname
        if (path === '/open-apis/auth/v3/tenant_access_token/internal') {
          if (++tokenRequests === 1) {
            tokenStarted.resolve()
            await releaseToken.promise
          }
          return Response.json({ tenant_access_token: 'isolated-test-token', expire: 3600 })
        }
        if (path === '/open-apis/im/v1/messages') {
          sent.push((await request.json()).receive_id)
          return Response.json({ code: 0, data: { message_id: 'om_test' } })
        }
        return new Response(null, { status: 404 })
      },
    })
    try {
      // The SDK path builder treats any explicit URL port as a path parameter.
      const http = lark.defaultHttpInstance.create({
        proxy: { host: '127.0.0.1', port: Number(server.url.port), protocol: 'http:' },
      })
      http.interceptors.response.use((response) => response.data)
      client = new lark.Client({
        appId: id,
        appSecret: 'test-only',
        domain: 'http://router.fixture.invalid',
        loggerLevel: lark.LoggerLevel.error,
        httpInstance: router.wrapTransport(http),
      })
      const revoked =
        kind === 'task card'
          ? router.send('oc_revoked', payload, signal(), () => authorized)
          : router.sendListenerReminder('oc_revoked', 3, 'ZeRo 监听 #3', signal(), () => authorized)
      await tokenStarted.promise
      authorized = false
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: 'oc_independent', msg_type: 'text', content: '{"text":"ok"}' },
      })
      releaseToken.resolve()
      expect((await revoked).status).toBe('rejected')
      expect(sent).toEqual(['oc_independent'])
    } finally {
      releaseToken.resolve()
      server.stop(true)
    }
  })

  test.each(kinds)(
    'prevents a duplicate %s after a write and keeps its status uncertain',
    async (kind) => {
      const h = await harness()
      let authorized = true
      let writes = 0
      const http = lark.defaultHttpInstance.create({
        adapter: async (config) => {
          writes++
          return { data: null, status: 200, statusText: 'OK', headers: {}, config }
        },
      })
      const guarded = h.channel.router.wrapTransport(http)
      h.create.mockImplementationOnce(async () => {
        await guarded.request({ method: 'POST', url: 'http://fixture.invalid' })
        // A personal reminder permits only one transport attempt even when its grant stays active.
        authorized = kind === 'personal reminder'
        return guarded.request({ method: 'POST', url: 'http://fixture.invalid' })
      })
      const result =
        kind === 'task card'
          ? await h.channel.router.send('oc_room', payload, signal(), () => authorized)
          : await h.channel.router.sendListenerReminder(
              'oc_room',
              19,
              '#监听19',
              signal(),
              () => authorized,
            )
      expect(result.status).toBe('unknown')
      expect(writes).toBe(1)
      await h.channel.stop()
    },
  )

  test('a revocation after dispatch preserves the native receipt', async () => {
    const h = await harness()
    let authorized = true
    h.create.mockImplementationOnce(async () => {
      authorized = false
      return { code: 0, data: { message_id: 'om_accepted' } }
    })
    expect(await h.channel.router.send('oc_room', payload, signal(), () => authorized)).toEqual({
      status: 'accepted',
      receipt: 'om_accepted',
    })
    await h.channel.stop()
  })

  test('requires app write grant, exact editable docx and active operation before any native write', async () => {
    const h = await harness()
    expect(
      (await h.channel.router.archive('https://elsewhere.test/docx', payload, signal())).status,
    ).toBe('rejected')
    h.scopes.mockImplementationOnce(async () => ({
      code: 0,
      data: { scopes: [{ scope_name: 'docx:document', grant_status: 1, scope_type: 'user' }] },
    }))
    expect((await h.channel.router.archive('doxcnTarget', payload, signal())).status).toBe(
      'rejected',
    )
    expect(h.access).not.toHaveBeenCalled()
    h.access.mockImplementationOnce(async () => ({ code: 0, data: { auth_result: false } }))
    expect((await h.channel.router.archive('doxcnTarget', payload, signal())).status).toBe(
      'rejected',
    )
    const stop = new AbortController()
    h.access.mockImplementationOnce(async () => {
      stop.abort()
      return { code: 0, data: { auth_result: true } }
    })
    expect((await h.channel.router.archive('doxcnTarget', payload, stop.signal)).status).toBe(
      'rejected',
    )
    expect(h.append).not.toHaveBeenCalled()
  })
})

test('generic archive preserves content beyond notification length and fences revoked writes', async () => {
  const h = await harness()
  const body = '完整原始证据和限制。'.repeat(400)
  h.append.mockImplementation(async (input) => {
    const count = (input as unknown as { data: { children: unknown[] } }).data.children.length
    return {
      code: 0,
      data: {
        client_token: input.params.client_token,
        children: Array.from({ length: count }, (_, i) => ({ block_id: `block${i}` })),
      },
    }
  })
  try {
    expect(
      (
        await h.channel.router.appendDocument(
          'DocToken',
          'archive-one',
          '测试归档',
          body,
          signal(),
          () => true,
        )
      ).status,
    ).toBe('accepted')
    const request = h.append.mock.calls[0][0] as unknown as {
      data: { children: Array<{ text: { elements: Array<{ text_run: { content: string } }> } }> }
    }
    expect(request.data.children.map((b) => b.text.elements[0].text_run.content).join('')).toBe(
      `测试归档\n${body}`,
    )
    expect(
      (
        await h.channel.router.appendDocument(
          'DocToken',
          'archive-two',
          '测试归档',
          body,
          signal(),
          () => false,
        )
      ).status,
    ).toBe('rejected')
    expect(h.append).toHaveBeenCalledTimes(1)
  } finally {
    await h.channel.stop()
  }
})

test('a long archive retains the last block and only acknowledges complete batches', async () => {
  const h = await harness()
  const body = '调查原文'.repeat(24500) + '🌿末尾的依据'
  const received: string[][] = []
  let rejectSecond = false
  h.append.mockImplementation(async (input) => {
    const req = input as typeof input & {
      data: { children: Array<{ text: { elements: [{ text_run: { content: string } }] } }> }
    }
    const contents = req.data.children.map((c) => c.text.elements[0].text_run.content)
    received.push(contents)
    if (rejectSecond && received.length === 2) return { code: 99991400 }
    return {
      code: 0,
      data: {
        client_token: input.params.client_token,
        children: contents.map((_, i) => ({ block_id: 'part-' + received.length + '-' + i })),
      },
    }
  })
  try {
    const send = () =>
      h.channel.router.appendDocument(
        'DocToken',
        'long-archive',
        '归档',
        body,
        signal(),
        () => true,
      )
    expect((await send()).status).toBe('accepted')
    expect(received.length).toBe(2)
    expect(received[0]).toHaveLength(50)
    expect(received.flat().join('')).toBe('归档\n' + body)
    const tokens = h.append.mock.calls.map(([i]) => i.params.client_token)
    expect(new Set(tokens).size).toBe(2)
    received.length = 0
    rejectSecond = true
    expect(await send()).toMatchObject({
      status: 'unknown',
      reason: expect.stringContaining('前 50 个文本块已写入'),
    })
    expect(h.append.mock.calls.slice(2).map(([i]) => i.params.client_token)).toEqual(tokens)
  } finally {
    await h.channel.stop()
  }
})
