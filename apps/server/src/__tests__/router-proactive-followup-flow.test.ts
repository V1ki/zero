import { expect, mock, test } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import { createGithubOwnerRequest } from '../triggers/github-owner-request'
import { createGithubWorkDelivery } from '../triggers/github-work-delivery'
import { createGithubInvestigator } from '../triggers/investigation'
import { acceptRepositoryWebhook } from '../triggers/repository-webhook'
import { createRouterEventWorker } from '../triggers/router-event-worker'
import { RouterGithubReplies } from '../triggers/router-github-reply'
import { createRouterJobDelivery } from '../triggers/router-job-delivery'
import { RouterJobPrincipals } from '../triggers/router-job-principal'
import { RouterJobs } from '../triggers/router-jobs'
import { TriggerRoutingRuntime } from '../triggers/routing-runtime'

test('ordinary signals are triaged once, investigated with evidence and continued by their original worker after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zero-proactive-followup-'))
  const name = 'fixture/subscriptions'
  const api = `https://api.github.com/repos/${name}`
  const web = `https://github.com/${name}`
  const repository = { id: 45, full_name: name, owner: { id: 1, login: 'fixture', type: 'User' } }
  // A listener never backfills changes from before its activation.
  const at = new Date(Date.now() + 2000).toISOString()
  const comment = (id: number, number: number, body: string, created_at = at) => ({
    id,
    user: { id: 2, login: 'reader', type: 'User' },
    author_association: 'NONE',
    created_at,
    updated_at: created_at,
    body,
    issue_url: `${api}/issues/${number}`,
    html_url: `${web}/issues/${number}#issuecomment-${id}`,
  })
  const initial = comment(401, 181, '以前的 Issue 提过 pnpm 会隐藏发布不足一天的版本。')
  const followup = comment(402, 181, '补充：今天重试仍然失败。')
  const chatter = comment(403, 180, '谢谢，已收到。')
  const earlier = comment(301, 159, 'pnpm 会隐藏发布不足一天的版本。', '2025-01-01T10:00:00Z')
  const pr = {
    number: 185,
    title: 'docs: correct README typo',
    body: 'Fix one spelling error.',
    state: 'open',
    draft: false,
    changed_files: 1,
    additions: 1,
    deletions: 1,
    head: { sha: 'a'.repeat(40) },
    base: { ref: 'main', repo: repository, sha: 'b'.repeat(40) },
    created_at: at,
    html_url: `${web}/pull/185`,
  }
  const issue = { number: 181, title: '安装失败', state: 'open', repository_url: api }
  const outbound = mock(async (): Promise<never> => {
    throw Error('Unexpected external delivery or write')
  })
  const reads: string[] = []
  async function fetchGithub(url: URL, init: RequestInit) {
    if ((init.method ?? 'GET') !== 'GET') return outbound()
    expect(url.origin).toBe('https://api.github.com')
    reads.push(url.pathname)
    if (url.href === api) return Response.json(repository)
    if (url.href === `${api}/issues/181`) return Response.json(issue)
    if (url.href === `${api}/pulls/185`) return Response.json(pr)
    if (url.href === `${api}/pulls/185/files?per_page=8`)
      return Response.json([
        { filename: 'docs/install-guide.md', patch: 'patch-content-is-private' },
      ])
    for (const row of [initial, followup, chatter, earlier]) {
      if (url.href === `${api}/issues/comments/${row.id}`) return Response.json(row)
    }
    if (url.pathname === '/search/issues') {
      expect(url.searchParams.get('q')).toContain(`repo:${name} is:issue`)
      return Response.json({
        total_count: 1,
        items: [
          {
            number: 159,
            title: 'pnpm 发布时间',
            html_url: `${web}/issues/159`,
            repository_url: api,
            created_at: earlier.created_at,
            text_matches: [
              {
                fragment: earlier.body,
                property: 'body',
                object_type: 'IssueComment',
                object_url: `${api}/issues/comments/301`,
              },
            ],
          },
        ],
      })
    }
    throw Error(`Unexpected fixture read: ${url.pathname}`)
  }

  const decisions: string[] = []
  const workerTurns: { session: string; prompt: string }[] = []
  const previousAnswer = '已核实历史讨论关于 pnpm 的记录，尚不能据此确认当前故障原因。'
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('Unexpected streaming')
    },
    async complete(req) {
      const session = req.meta?.sessionId ?? ''
      const messages = JSON.stringify(req.messages)
      const envelope = { id: 'fixture', model: 'fixture', usage: { input: 1, output: 1 } }
      const finish = (payload: object) => ({
        ...envelope,
        stopReason: 'end_turn' as const,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      })
      if (session.startsWith('router-followup-triage-')) {
        expect(req.tools ?? []).toHaveLength(0)
        decisions.push(session)
        return messages.includes(chatter.body)
          ? finish({ decision: 'observe', reason: '用户只确认收悉。' })
          : finish({ decision: 'act', reason: '有具体且可核查的线索。' })
      }
      expect(session).toMatch(/^router-watch-job-/)
      const next = messages.includes(followup.body)
      const docs = messages.includes(pr.title)
      const tool = next || docs ? 'inspect_github' : 'find_related_issues'
      if (req.messages.at(-1)?.content[0]?.type !== 'tool_result') {
        workerTurns.push({ session, prompt: messages })
        expect(req.tools?.map((definition) => definition.name)).toContain(tool)
        return {
          ...envelope,
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'query', name: tool, input: {} }],
        }
      }
      expect(messages).toContain(
        next ? followup.body : docs ? 'docs/install-guide.md' : earlier.html_url,
      )
      if (docs) {
        expect(messages).toContain('1 个文件，新增 1 行，删除 1 行')
        expect(messages).not.toContain('patch-content-is-private')
      }
      return finish({
        outcome: 'resolved',
        attentionQuestion: null,
        result: next
          ? '已核实后续重试记录。'
          : docs
            ? '已核实仅有一个文档文件改动，一行新增、一行删除。'
            : previousAnswer,
      })
    },
  }
  const auth = {
    getToken: async () => 'test',
    getCommentIdentity: async () => 'fixture-bot[bot]',
    getCommentAccess: outbound,
  }
  function boot() {
    const store = new TriggerStore(join(directory, 'inbox.sqlite'))
    const principals = new RouterJobPrincipals(store, {
      accessKey: () => store.getRouterGithubGrant('web')?.credentialRef ?? null,
    })
    if (!store.getSettings().revision) {
      store.saveSettings(
        {
          github: {
            credentialRef: 'github_listener_fixture',
            routerTrackingEnabled: true,
            repositories: [
              {
                name,
                enabled: true,
                githubAppRef: 'github_app_fixture',
                ownerMentionReplies: true,
                issues: true,
                pullRequests: true,
                issueComments: true,
                mention: '',
                branch: '',
                workflow: '',
                workflowFailures: false,
                deliveryMode: 'webhook',
                webhookSecretRef: 'github_webhook_fixture',
              },
            ],
          },
          wxarc: { sessions: [] },
        },
        0,
      )
      const audience = principals.capture('web', true)
      const grant = store.tracking.grant('web')
      if (!grant) throw Error('Missing fixture grant')
      store.tracking.start({
        actor: 'web',
        scope: 'general',
        requestId: 'start',
        repository: name,
        issues: true,
        pullRequests: true,
        issueComments: true,
        audience,
        ownerAudience: audience,
        expectedGrantGeneration: grant.generation,
      })
    }
    const filter = (s: string) => s
    const settings = () => store.getSettings()
    const ownerRequest = createGithubOwnerRequest(settings, auth, filter, fetchGithub)
    const investigator = createGithubInvestigator(
      settings,
      () => undefined,
      filter,
      fetchGithub,
      auth,
    )
    const worker = createRouterEventWorker(
      {
        modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
        secretFilter: { filter },
      },
      store.tracking,
      { investigator, ownerRequest, closeIssue: outbound },
    )
    const replies = new RouterGithubReplies(store, auth, filter, outbound)
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: outbound,
      weixin: { listTargets: () => [], send: outbound },
    })
    const deliver = createRouterJobDelivery(
      routing,
      worker.authorized,
      undefined,
      createGithubWorkDelivery(store, replies, ownerRequest, worker.authorized),
    )
    const deliveries = new Map<string, Awaited<ReturnType<typeof deliver>>>()
    const jobs = new RouterJobs(store.jobs, {
      authorized: principals.authorized.bind(principals),
      tracking: worker,
      execute: outbound,
      async completed(job, signal) {
        const result = await deliver(job, signal)
        deliveries.set(`${job.id}:${job.attempt}`, result)
        return result
      },
    })
    jobs.start()
    async function push(kind: string, payload: object) {
      const body = JSON.stringify({ repository, ...payload })
      const response = await acceptRepositoryWebhook(
        'github',
        name,
        new Request('http://localhost/hook', {
          method: 'POST',
          body,
          headers: {
            'content-type': 'application/json',
            'x-github-delivery': randomUUID(),
            'x-github-event': kind,
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`,
          },
        }),
        {
          store,
          resolveSecret: () => 'test-secret',
          githubToken: outbound,
          signal: new AbortController().signal,
          accepted: (_name, hasEvents) => {
            if (hasEvents) jobs.notify()
          },
        },
      )
      expect(response.status).toBe(200)
    }
    return {
      store,
      pushComment: (number: number, value: typeof initial) =>
        push('issue_comment', { action: 'created', issue: { number }, comment: value }),
      pushPr: () => push('pull_request', { action: 'opened', number: pr.number, pull_request: pr }),
      async settled(inboxId: number) {
        const result = () => store.tracking.resultForEvent(inboxId, worker.authorized)
        for (let i = 0; i < 160; i++) {
          const item = result()
          if (item && (item.status === 'failed' || item.status === 'unknown')) return item
          const delivery = item && deliveries.get(`${item.id}:${item.attempt}`)
          if (item?.status === 'completed' && delivery) {
            expect(delivery).toBe('delivered')
            return item
          }
          await Bun.sleep(5)
        }
        throw Error(`Follow-up for inbox #${inboxId} did not settle: ${JSON.stringify(result())}`)
      },
      async close() {
        await jobs.close()
        await replies.close()
        store.close()
      },
    }
  }
  let runtime = boot()
  try {
    await runtime.pushComment(181, initial)
    const first = await runtime.settled(1)
    expect(first).toMatchObject({
      status: 'completed',
      attempt: 1,
      needsAttention: false,
      work: {
        outcome: 'resolved',
        steps: [{ tool: 'find_related_issues', ok: true }],
        followup: { kind: 'new', decision: 'act' },
      },
    })
    expect(first.work?.sources.map(({ url }) => url)).toContain(earlier.html_url)
    expect(reads).toContain(`/repos/${name}/issues/comments/301`)
    await runtime.close()
    runtime = boot()
    await runtime.pushComment(181, initial)
    await runtime.pushComment(181, followup)
    await runtime.pushComment(181, followup)
    const second = await runtime.settled(2)
    expect(second).toMatchObject({
      id: first.id,
      attempt: 2,
      status: 'completed',
      work: {
        outcome: 'resolved',
        steps: [{ tool: 'inspect_github', ok: true }],
        followup: { kind: 'continue', decision: 'act' },
      },
    })
    expect(workerTurns[1].session).toBe(workerTurns[0].session)
    expect(workerTurns[1].prompt).toContain(previousAnswer)
    expect(workerTurns[1].prompt).toContain(earlier.html_url)
    expect(decisions).toHaveLength(1)
    await runtime.pushComment(180, chatter)
    expect(await runtime.settled(3)).toMatchObject({
      status: 'completed',
      needsAttention: false,
      work: { outcome: 'observed', steps: [], followup: { kind: 'new', decision: 'observe' } },
    })
    expect(workerTurns).toHaveLength(2)
    await runtime.pushPr()
    const smallPr = await runtime.settled(4)
    expect(smallPr).toMatchObject({
      status: 'completed',
      needsAttention: false,
      work: { outcome: 'resolved', steps: [{ tool: 'inspect_github', ok: true }] },
    })
    expect(smallPr.id).not.toBe(first.id)
    expect(reads).toContain(`/repos/${name}/pulls/185/files`)
    expect(runtime.store.listInbox()).toHaveLength(4)
    expect(new Set(decisions).size).toBe(3)
    expect(workerTurns).toHaveLength(3)
    expect(runtime.store.githubReplies.latest(1)).toBeUndefined()
  } finally {
    await runtime.close()
    rmSync(directory, { recursive: true, force: true })
  }
  expect(outbound).not.toHaveBeenCalled()
})
