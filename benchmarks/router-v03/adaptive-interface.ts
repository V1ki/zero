import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'
import { TriggerStore } from '@zero-os/observe'
import type { AgentDependencies } from '../../apps/server/src/triggers/event-agent'
import { createRouterAgent } from '../../apps/server/src/triggers/router-agent'
import { createRouterTraceSink } from '../../apps/server/src/triggers/router-trace'
import { RouterWorkspaceService } from '../../apps/server/src/triggers/router-workspace'
import { TriggerRoutingRuntime } from '../../apps/server/src/triggers/routing-runtime'

/** Real model, workbench and click. Only the HTTP host and input data are isolated. */
export async function verifyAdaptiveInterface(output: string, deps: AgentDependencies) {
  // A reviewer can supply a different task after freezing the implementation.
  const caseFile = process.env.ZERO_ACCEPTANCE_UI_CASE
  const sample: {
    first: string
    firstFacts: string[]
    second: string
    revisedFacts: string[]
    action: string
    selection: string
  } = caseFile
    ? JSON.parse(readFileSync(caseFile, 'utf8'))
    : {
        first:
          '我们7人要选读书会场地。北岸能坐12人，收费90元；南庭能坐8人，收费60元。只做选择记录。请建一件事项，在当前对话用可操作的比较卡列出两处，各给一个选择按钮；等我最后决定。',
        firstFacts: ['北岸', '南庭', '12', '8', '90', '60'],
        second:
          '人数改为11人，请更新刚才那件事。这次我只要能坐下全部人的方案，在当前对话给我一张简短的决定卡，唯一的按钮写「选定北岸」。我点了就记录选择、结束这件事，不需要预约。',
        revisedFacts: ['11', '北岸'],
        action: '选定北岸',
        selection: '北岸',
      }
  const store = new TriggerStore(join(output, 'workspace.sqlite'))
  const external = async (): Promise<never> => {
    throw Error('Unexpected external operation')
  }
  const routing = new TriggerRoutingRuntime(store.routing, {
    analyze: external,
    weixin: { listTargets: () => [], send: external },
  })
  const ask = createRouterAgent({
    ...deps,
    modelRouter: {
      ...deps.modelRouter,
      trace: createRouterTraceSink(store.ledger, (s) => deps.secretFilter.filter(s)),
    },
  })
  const service = new RouterWorkspaceService(store, routing, ask, {
    principalFor: () => 'router-owner',
    agentIntake: true,
  })
  const assets = join(process.cwd(), 'apps/web/dist')
  assert(await Bun.file(join(assets, 'index.html')).exists(), 'Build the workbench first')
  const host = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/listeners/workspace/general' && req.method === 'GET')
        return Response.json(service.get('general'))
      if (path === '/api/listeners/workspace/general/messages' && req.method === 'POST') {
        const { requestId, text, background } = await req.json()
        return Response.json(await service.message('general', requestId, text, false, background), {
          status: background ? 202 : 200,
        })
      }
      if (path === '/api/listeners/workspace/general/actions' && req.method === 'POST') {
        const { requestId, action } = await req.json()
        return Response.json(await service.action('general', requestId, action))
      }
      if (path === '/api/listeners/router-publications')
        return Response.json(service.listPublications(new URL(req.url).searchParams.get('id') ?? undefined))
      if (path === '/api/listeners/router-matters') return Response.json(service.listMatters())
      const publicationAction = path.match(
        /^\/api\/listeners\/router-publications\/([^/]+)\/actions$/,
      )
      if (publicationAction && req.method === 'POST') {
        const { actionId, requestId, gesture } = await req.json()
        return Response.json(
          service.webPublicationAction(publicationAction[1], actionId, requestId, gesture),
        )
      }
      if (path === '/api/listeners/workspace-events') return Response.json({ items: [] })
      if (path === '/api/status') return Response.json({ currentModel: 'Router' })
      if (path === '/router') return new Response(Bun.file(join(assets, 'index.html')))
      if (path.startsWith('/assets/')) return new Response(Bun.file(join(assets, path)))
      return new Response(null, { status: 404 })
    },
  })
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage()
  async function askThroughPage(text: string) {
    await page.getByRole('textbox', { name: '给 Router 发消息' }).fill(text)
    const response = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith('/general/messages'),
      { timeout: 180_000 },
    )
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const accepted = await response
    assert(accepted.ok())
    const { requestId } = accepted.request().postDataJSON()
    for (let n = 0; n < 1000; n++) {
      const turn = store.conversations.get('general', requestId)
      if (turn?.status === 'failed') throw Error(turn.error ?? 'Router turn failed')
      if (turn?.status === 'completed') return service.get('general')
      await Bun.sleep(250)
    }
    throw Error('No completed browser turn in the observation interval')
  }
  function turnCard(state: ReturnType<typeof service.get>) {
    const turn = state.turns.at(-1)!
    if (turn.answer?.generatedUI) return { ui: turn.answer.generatedUI }
    const publication = service
      .listPublications()
      .find((p) =>
        p.traceReceipts.some(
          (receipt) =>
            receipt.operation === 'publish_update' && turn.traceRunIds?.includes(receipt.runId),
        ),
      )
    const web = publication?.deliveries.find((d) => d.channel === 'web' && d.status === 'accepted')
    return { ui: web?.presentation.generatedUI, publicationId: publication?.id }
  }
  try {
    service.start()
    await page.goto(new URL('/router', host.url).href)
    const first = await askThroughPage(sample.first)
    const { ui: comparison, publicationId } = turnCard(first)
    assert(
      comparison && Object.keys(comparison.actions).length >= 2,
      'Missing generated choice card',
    )
    await page.goto(new URL('/router', host.url).href)
    if (publicationId) {
      const link = page
        .locator('.rw-dialog')
        .getByRole('link', { name: /打开「/ })
        .last()
      await link.focus()
      await page.keyboard.press('Enter')
      await page.locator(`#rw-publication-${publicationId}:focus`).waitFor()
    }
    const card = publicationId
      ? page.locator(`#rw-publication-${publicationId} .router-a2ui`)
      : page
          .locator('.rw-dialog .router-a2ui')
          .filter({ has: page.getByRole('button') })
          .last()
    await card.waitFor()
    const firstText = await card.innerText()
    assert(sample.firstFacts.every((s) => firstText.includes(s)))
    await card.screenshot({ path: join(output, 'choices.png') })
    const matter = store.ledger.searchMatters('router-owner')[0]
    assert(
      matter &&
        Object.values(comparison.actions).every(
          (a) => a.matterId === matter.id && a.matterVersion === matter.version,
        ),
      'Choices must identify the current matter version',
    )
    if (publicationId) await page.goto(new URL('/router', host.url).href)
    const withNote = process.env.ZERO_ACCEPTANCE_FORM === '1'
    const second = await askThroughPage(
      sample.second +
        (withNote
          ? '卡片上还要有一个必填的备注输入框。我填什么，你就把原文和场地选择一并保存。'
          : ''),
    )
    const { ui: choice, publicationId: secondPublication } = turnCard(second)
    assert(choice && Object.keys(choice.actions).length === 1)
    assert(
      Object.values(choice.actions)[0].matterVersion ===
        store.ledger.getMatter('router-owner', matter.id)?.version,
    )
    await page.reload()
    const button = page.getByRole('button', { name: sample.action, exact: true }).last()
    await button.waitFor()
    const revised = page.locator('.router-a2ui').filter({ has: button })
    const revisedText = await revised.innerText()
    assert(sample.revisedFacts.every((fact) => revisedText.includes(fact)))
    await revised.screenshot({ path: join(output, 'decision.png') })
    const note = '请给会后整理留两把椅子。'
    if (withNote) {
      await button.click()
      await revised.getByRole('alert').waitFor()
      assert.equal(store.ledger.listRuns().length, 2, 'An empty form must not start an Agent turn')
      await revised.getByRole('textbox').fill(note)
    }
    const result = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith(
          secondPublication ? '/' + secondPublication + '/actions' : '/general/actions',
        ),
      { timeout: 180_000 },
    )
    await button.click()
    const response = await result
    assert(response.ok(), 'Clicked action did not reach workspace')
    if (secondPublication) {
      for (
        let n = 0;
        n < 1000 && store.ledger.getMatter('router-owner', matter.id)?.state !== 'completed';
        n++
      )
        await Bun.sleep(200)
    }
    const final = store.ledger.getMatter('router-owner', matter.id)
    assert.equal(final?.state, 'completed')
    assert(JSON.stringify(final.context).includes(sample.selection))
    if (withNote)
      assert(
        JSON.stringify(final.context).includes(note),
        'The submitted note is absent from the matter',
      )
    const runs = store.ledger.listRuns().map((r) => {
      const entries = store.ledger.entries(r.id)
      const raw = entries.find((e) => e.kind === 'input')?.data as { prompt: string }
      return {
        id: r.id,
        kind: JSON.parse(raw.prompt).signal.kind,
        calls: entries
          .filter((e) => e.kind === 'model_response')
          .map((entry) => {
            const response = (entry.data as { response: { model: string; usage: unknown } })
              .response
            return { model: response.model, usage: response.usage }
          }),
        tools: entries
          .filter((e) => e.kind === 'tool_start')
          .map((e) => (e.data as { name: string }).name),
      }
    })
    assert(
      runs.filter(
        (r) =>
          r.kind === 'user' &&
          (r.tools.includes('present_ui') || r.tools.includes('publish_update')),
      ).length === 2,
    )
    assert(runs.some((r) => r.kind === 'ui_action' && r.tools.includes('update_matter')))
    writeFileSync(
      join(output, 'interface.json'),
      JSON.stringify({ firstText, revisedText, matterId: matter.id, runs, final }, null, 2),
    )
  } catch (error) {
    writeFileSync(
      join(output, 'interface-failure.json'),
      JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
    )
    throw error
  } finally {
    await browser.close()
    await service.close()
    await host.stop(true)
    await routing.close()
    store.close()
  }
}
