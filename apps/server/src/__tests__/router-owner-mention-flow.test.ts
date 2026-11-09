import { expect, test } from 'bun:test'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderAdapter } from '@zero-os/model'
import { TriggerStore } from '@zero-os/observe'
import { postGithubAppComment } from '../triggers/github-app-comment'
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

test('signed owner mention autonomously investigates a historical comment and replies once across redelivery and restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zero-mention-flow-'))
  const name = 'fixture/docs'
  const api = `https://api.github.com/repos/${name}`
  const web = `https://github.com/${name}`
  const at = new Date(Date.now() + 2000).toISOString()
  const user = { id: 83, login: 'fixture', type: 'User' }
  const repository = { id: 45, full_name: name, owner: user }
  const comment = {
    id: 311,
    user,
    author_association: 'OWNER',
    created_at: at,
    updated_at: at,
    body: '@fixture-bot 帮我查找之前关于 Ledger 恢复校验的 Issue 原评论链接。',
    issue_url: `${api}/issues/10`,
    html_url: `${web}/issues/10#issuecomment-311`,
  }
  const earlier = {
    id: 37,
    created_at: '2025-01-01T10:00:00Z',
    body: 'Ledger 恢复时必须核对校验值。',
    issue_url: `${api}/issues/5`,
    html_url: `${web}/issues/5#issuecomment-37`,
  }
  const webhook = JSON.stringify({ action: 'created', repository, issue: { number: 10 }, comment })
  const auth = {
    getToken: async () => 'test-read',
    getCommentIdentity: async () => 'fixture-bot[bot]',
    getCommentAccess: async () => ({ token: 'test-write', botLogin: 'fixture-bot[bot]' }),
  }
  const posts: string[] = []
  let modelCalls = 0
  let searches = 0
  const denied = async (): Promise<never> => {
    throw Error('Unexpected operation')
  }
  async function github(url: URL, init: RequestInit) {
    expect(url.origin).toBe('https://api.github.com')
    if (init.method === 'POST') {
      expect(url.href).toBe(`${api}/issues/10/comments`)
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-write')
      posts.push(JSON.parse(String(init.body)).body)
      return Response.json(
        {
          id: 984,
          user: { login: 'fixture-bot[bot]', type: 'Bot' },
          issue_url: comment.issue_url,
          html_url: `${web}/issues/10#issuecomment-984`,
        },
        { status: 201 },
      )
    }
    if (init.method && init.method !== 'GET') return denied()
    if (url.href === api) return Response.json(repository)
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-read')
    if (url.href === `${api}/issues/comments/311`) return Response.json(comment)
    if (url.href === `${api}/issues/10`)
      return Response.json({ number: 10, state: 'open', repository_url: api, title: '恢复校验' })
    if (url.href === `${api}/issues/comments/37`) return Response.json(earlier)
    if (url.pathname === '/search/issues') {
      searches++
      expect(url.searchParams.get('q')).toContain(`repo:${name} is:issue`)
      return Response.json({
        total_count: 1,
        items: [
          {
            number: 5,
            title: '历史上的恢复校验',
            repository_url: api,
            html_url: `${web}/issues/5`,
            created_at: earlier.created_at,
            text_matches: [
              {
                fragment: earlier.body,
                property: 'body',
                object_type: 'IssueComment',
                object_url: `${api}/issues/comments/37`,
              },
            ],
          },
        ],
      })
    }
    throw Error(`Unexpected GitHub read: ${url.pathname}`)
  }
  const adapter: ProviderAdapter = {
    apiType: 'test',
    healthCheck: async () => true,
    stream() {
      throw Error('No stream')
    },
    async complete(req) {
      const common = { id: 'work', model: 'test', usage: { input: 1, output: 1 } }
      modelCalls++
      if (modelCalls === 1) {
        expect(req.tools?.map((t) => t.name)).toContain('find_related_issues')
        return {
          ...common,
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'lookup', name: 'find_related_issues', input: {} }],
        }
      }
      expect(JSON.stringify(req.messages)).toContain(earlier.html_url)
      return {
        ...common,
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              outcome: 'resolved',
              attentionQuestion: null,
              result: '找到了关于 Ledger 恢复校验的旧评论。',
            }),
          },
        ],
      }
    },
  }
  function boot(first: boolean) {
    const store = new TriggerStore(join(directory, 'inbox.sqlite'))
    if (first) {
      store.saveSettings(
        {
          github: {
            credentialRef: 'github_listener_fixture',
            routerTrackingEnabled: true,
            repositories: [
              {
                name,
                enabled: true,
                issues: true,
                issueComments: true,
                ownerMentionReplies: true,
                githubAppRef: 'github_app_fixture',
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
    }
    const principals = new RouterJobPrincipals(store, {
      accessKey: () => store.getRouterGithubGrant('web')?.credentialRef ?? null,
    })
    if (first) {
      const audience = principals.capture('web', true)
      const grant = store.tracking.grant('web')
      if (!grant) throw new Error('Missing fixture grant')
      store.tracking.start({
        actor: 'web',
        scope: 'general',
        requestId: 'watch',
        repository: name,
        issues: true,
        pullRequests: false,
        issueComments: true,
        ownerAudience: audience,
        audience,
        expectedGrantGeneration: grant.generation,
      })
    }
    const filter = (s: string) => s
    const getSettings = () => store.getSettings()
    const ownerRequest = createGithubOwnerRequest(getSettings, auth, filter, github)
    const investigator = createGithubInvestigator(
      getSettings,
      () => undefined,
      filter,
      github,
      auth,
    )
    const tracking = createRouterEventWorker(
      {
        modelRouter: { getDefaultModel: () => ({ adapter }), getCurrentModel: () => undefined },
        secretFilter: { filter },
      },
      store.tracking,
      { investigator, ownerRequest },
    )
    const replies = new RouterGithubReplies(store, auth, filter, (app, input) =>
      postGithubAppComment(app, input, github),
    )
    const routing = new TriggerRoutingRuntime(store.routing, {
      analyze: denied,
      weixin: { listTargets: () => [], send: denied },
    })
    const delivery = createRouterJobDelivery(
      routing,
      (job) => tracking.authorized(job),
      undefined,
      createGithubWorkDelivery(store, replies, ownerRequest, (job) => tracking.authorized(job)),
    )
    const jobs = new RouterJobs(store.jobs, {
      authorized: principals.authorized.bind(principals),
      tracking,
      execute: denied,
      completed: delivery,
    })
    jobs.start()
    const push = () =>
      acceptRepositoryWebhook(
        'github',
        name,
        new Request('http://localhost/hook', {
          method: 'POST',
          body: webhook,
          headers: {
            'content-type': 'application/json',
            'x-github-delivery': randomUUID(),
            'x-github-event': 'issue_comment',
            'x-hub-signature-256': `sha256=${createHmac('sha256', 'fixture-secret').update(webhook).digest('hex')}`,
          },
        }),
        {
          store,
          resolveSecret: () => 'fixture-secret',
          githubToken: denied,
          signal: new AbortController().signal,
          accepted: (_name, hasEvents) => {
            if (hasEvents) jobs.notify()
          },
        },
      )
    return {
      store,
      push,
      replies,
      async close() {
        await jobs.close()
        await replies.close()
        store.close()
      },
    }
  }
  let system = boot(true)
  try {
    expect((await system.push()).status).toBe(200)
    for (let i = 0; i < 150 && system.store.githubReplies.latest(1)?.state !== 'sent'; i++)
      await Bun.sleep(5)
    expect(system.store.tracking.listResults()).toMatchObject([
      {
        inboxId: 1,
        status: 'completed',
        work: { outcome: 'resolved', steps: [{ tool: 'find_related_issues', ok: true }] },
      },
    ])
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain(earlier.html_url)
    await system.close()
    system = boot(false)
    expect((await system.push()).status).toBe(200)
    expect(await system.replies.preview(1)).toMatchObject({
      delivery: { state: 'sent', origin: 'worker', url: `${web}/issues/10#issuecomment-984` },
    })
    expect(system.store.listInbox()).toHaveLength(1)
    expect(system.store.tracking.listResults()).toHaveLength(1)
  } finally {
    await system.close()
    rmSync(directory, { recursive: true, force: true })
  }
  expect([modelCalls, searches, posts.length]).toEqual([2, 1, 1])
})
