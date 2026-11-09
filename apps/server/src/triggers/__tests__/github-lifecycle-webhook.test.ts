import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerGithubRepository } from '@zero-os/shared'
import { GithubWebhookPayloadError, normalizeGithubWebhook } from '../github'
import { acceptRepositoryWebhook } from '../repository-webhook'

const repo: TriggerGithubRepository = {
  name: 'Owner/Project',
  issues: true,
  pullRequests: true,
  branch: 'release',
  mention: '',
  workflow: '',
  enabled: true,
  workflowFailures: false,
}
const repository = { id: 42, full_name: 'owner/project' }
const item = {
  title: 'Example',
  number: 7,
  repository_url: 'https://api.github.com/repos/Owner/Project',
  created_at: '2026-01-01T10:00:00Z',
  updated_at: '2026-02-01T09:45:00Z',
  closed_at: '2026-02-01T09:44:00Z',
}
const pull = {
  ...item,
  base: { ref: 'main', repo: repository },
  head: { ref: 'feature', repo: { id: 36, full_name: 'fork/project' } },
  merged: false,
  merged_at: null,
}
const noExternalRead = () => {
  throw new Error('Signed lifecycle events require no API calls')
}
const normalize = (event: string, body: Record<string, unknown>, settings = repo) =>
  normalizeGithubWebhook(
    settings,
    event,
    { repository, ...body },
    noExternalRead,
    new AbortController().signal,
    noExternalRead,
  )

describe('GitHub lifecycle webhooks', () => {
  test('an authenticated issue delivery reaches the inbox once across separate delivery IDs', async () => {
    const store = new TriggerStore(':memory:')
    try {
      const secret = 'isolated-test'
      store.saveSettings(
        {
          github: {
            credentialRef: '',
            repositories: [
              {
                ...repo,
                deliveryMode: 'webhook',
                webhookSecretRef: 'github_webhook_sample',
              },
            ],
          },
          wxarc: { sessions: [] },
        },
        0,
      )
      const body = JSON.stringify({
        repository,
        action: 'opened',
        issue: { ...item, created_at: new Date().toISOString() },
      })
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
      const deliver = (value: string) =>
        acceptRepositoryWebhook(
          'github',
          repo.name,
          new Request('http://localhost/webhook', {
            method: 'POST',
            body,
            headers: {
              'content-type': 'application/json',
              'x-github-event': 'issues',
              'x-github-delivery': crypto.randomUUID(),
              'x-hub-signature-256': value,
            },
          }),
          {
            store,
            signal: new AbortController().signal,
            resolveSecret: () => secret,
            githubToken: noExternalRead,
            accepted: () => {},
          },
        )
      expect((await deliver('invalid')).status).toBe(401)
      expect(store.listInbox()).toHaveLength(0)
      expect((await deliver(signature)).status).toBe(200)
      expect((await deliver(signature)).status).toBe(200)
      expect(store.listInbox().map((e) => [e.source, e.url])).toEqual([
        ['github', 'https://github.com/Owner/Project/issues/7'],
      ])
    } finally {
      store.close()
    }
  })

  for (const [action, at] of [
    ['opened', item.created_at],
    ['reopened', item.updated_at],
    ['closed', item.closed_at],
  ] as const) {
    test(`normalizes ${action} for repository issues and pull requests`, async () => {
      const [issue] = await normalize('issues', { action, issue: item })
      const [pr] = await normalize('pull_request', { action, number: 7, pull_request: pull })
      expect(issue).toMatchObject({
        eventId: `42:issue:7:${action}:${Date.parse(at)}`,
        businessKey: 'issue:7',
        url: 'https://github.com/Owner/Project/issues/7',
      })
      expect(pr).toMatchObject({
        eventId: `42:pr:7:${action}:${Date.parse(at)}`,
        businessKey: 'pr:7',
        url: 'https://github.com/Owner/Project/pull/7',
      })
    })
  }

  test('a merged close is a single stable merge even on redelivery', async () => {
    const mergedAt = '2026-02-01T09:43:00Z'
    const payload = {
      action: 'closed',
      number: 7,
      pull_request: { ...pull, merged: true, merged_at: mergedAt },
    }
    const events = await normalize('pull_request', payload)
    expect(events.map((e) => e.eventId)).toEqual([`42:pr:7:merged:${Date.parse(mergedAt)}`])
    expect(await normalize('pull_request', payload)).toEqual(events)
  })

  test('requires the selected event family and ignores unrelated updates', async () => {
    expect(await normalize('issues', { action: 'opened' }, { ...repo, issues: false })).toEqual([])
    expect(
      await normalize('pull_request', { action: 'opened' }, { ...repo, pullRequests: false }),
    ).toEqual([])
    expect(await normalize('issues', { action: 'edited' })).toEqual([])
    expect(await normalize('pull_request', { action: 'synchronize' })).toEqual([])
  })

  test('refuses mismatched objects and invalid or contradictory event evidence', async () => {
    for (const bad of [
      { number: 8 },
      { base: { repo: { id: 99 } } },
      { base: { repo: { id: 42, full_name: 'other/project' } } },
      { merged: true, merged_at: null },
      { merged: false, merged_at: item.closed_at },
      { closed_at: 'invalid' },
    ])
      await expect(
        normalize('pull_request', {
          action: 'closed',
          number: 7,
          pull_request: { ...pull, ...bad },
        }),
      ).rejects.toBeInstanceOf(GithubWebhookPayloadError)
    await expect(
      normalize('issues', {
        action: 'opened',
        issue: { ...item, repository_url: 'https://api.github.com/repos/another/repo' },
      }),
    ).rejects.toBeInstanceOf(GithubWebhookPayloadError)
    await expect(
      normalize('issues', { action: 'opened', issue: { ...item, pull_request: {} } }),
    ).rejects.toBeInstanceOf(GithubWebhookPayloadError)
  })
})
