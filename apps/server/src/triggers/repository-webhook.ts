import { createHmac, timingSafeEqual } from 'node:crypto'
import type { TriggerStore } from '@zero-os/observe'
import {
  type TriggerEvent,
  type TriggerIgnoredDiscussion,
  type TriggerGithubRepository,
  triggerWebhookSecretPatterns,
} from '@zero-os/shared'
import { GithubWebhookPayloadError, normalizeGithubWebhook } from './github'
import type { GithubAppAuth } from './github-app-auth'

export type RepositoryWebhookProvider = 'github' | 'ci'

interface WebhookDependencies {
  store: Pick<TriggerStore, 'getSettings' | 'getStreamStartedAt' | 'commitPush'>
  resolveSecret(ref: string): string | undefined
  githubToken(
    ref: string,
    repo: TriggerGithubRepository,
    signal: AbortSignal,
  ): string | undefined | Promise<string | undefined>
  accepted(scope: string, hasEvents: boolean): void
  signal: AbortSignal
  githubAppIdentity?: GithubAppAuth['getCommentIdentity']
}

const maxBytes = 1024 * 1024
class WebhookError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function readBody(request: Request): Promise<Buffer> {
  if (Number(request.headers.get('content-length')) > maxBytes)
    throw new WebhookError(413, 'Payload exceeds 1 MiB')
  const reader = request.body?.getReader()
  if (!reader) throw new WebhookError(400, 'Missing payload')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return Buffer.concat(chunks, length)
      length += value.byteLength
      if (length > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new WebhookError(413, 'Payload exceeds 1 MiB')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function ciFailure(repo: TriggerGithubRepository, payload: unknown): TriggerEvent[] {
  if (typeof payload !== 'object' || !payload || Array.isArray(payload))
    throw new WebhookError(400, 'Invalid CI payload')
  const data = payload as Record<string, unknown>
  const { version, kind, eventId, repository, occurredAt, branch, workflow, summary } = data
  if (
    version !== 1 ||
    kind !== 'workflow_failure' ||
    typeof repository !== 'string' ||
    repository.toLowerCase() !== repo.name.toLowerCase() ||
    typeof eventId !== 'string' ||
    !/^[a-z\d][a-z\d._:/-]{0,191}$/i.test(eventId) ||
    typeof branch !== 'string' ||
    !branch.trim() ||
    branch.length > 255 ||
    typeof workflow !== 'string' ||
    !workflow.trim() ||
    workflow.length > 255 ||
    typeof occurredAt !== 'string' ||
    occurredAt.length > 40 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(occurredAt) ||
    !Number.isFinite(Date.parse(occurredAt)) ||
    (summary !== undefined && (typeof summary !== 'string' || summary.length > 1000))
  )
    throw new WebhookError(400, 'Invalid CI payload or repository')
  if (
    !repo.workflowFailures ||
    (repo.branch && repo.branch !== branch) ||
    (repo.workflow && repo.workflow !== workflow)
  )
    return []
  return [
    {
      eventId: `ci:${eventId}`,
      scope: repo.name,
      title: `CI · ${workflow} 失败`,
      summary: [repo.name, branch, summary].filter(Boolean).join(' · '),
      occurredAt: new Date(occurredAt).toISOString(),
    },
  ]
}

/** Acknowledge only after the scoped SQLite transaction has completed. */
export async function acceptRepositoryWebhook(
  provider: RepositoryWebhookProvider,
  scope: string,
  request: Request,
  deps: WebhookDependencies,
): Promise<Response> {
  try {
    if (deps.signal.aborted) throw new WebhookError(503, 'Listener is stopping')
    const { settings, revision } = deps.store.getSettings()
    const repo = settings.github.repositories.find(
      (r) => r.enabled && r.name.toLowerCase() === scope.toLowerCase(),
    )
    const ref =
      provider === 'github'
        ? repo?.deliveryMode === 'webhook' && repo.webhookSecretRef
        : repo?.workflowFailures && repo.ciWebhookSecretRef
    if (!repo || !ref || !triggerWebhookSecretPatterns[provider].test(ref))
      throw new WebhookError(404, 'Webhook is not configured')
    const signatureHeader = provider === 'github' ? 'x-hub-signature-256' : 'x-zero-signature-256'
    const signature = /^sha256=([\da-f]{64})$/i.exec(request.headers.get(signatureHeader) ?? '')
    if (!signature) throw new WebhookError(401, 'Invalid webhook signature')
    if (
      request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json'
    )
      throw new WebhookError(415, 'Use application/json')
    const secret = deps.resolveSecret(ref)
    if (!secret) throw new WebhookError(503, 'Webhook secret is unavailable')
    const body = await readBody(request)
    const mac = createHmac('sha256', secret).update(body).digest()
    if (!timingSafeEqual(mac, Buffer.from(signature[1], 'hex')))
      throw new WebhookError(401, 'Invalid webhook signature')
    let payload: unknown
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    } catch {
      throw new WebhookError(400, 'Invalid JSON payload')
    }
    let events: TriggerEvent[]
    const ignored: TriggerIgnoredDiscussion[] = []
    if (provider === 'github') {
      const delivery = request.headers.get('x-github-delivery') ?? ''
      const event = request.headers.get('x-github-event') ?? ''
      if (
        !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(delivery) ||
        !/^[a-z_]{1,64}$/.test(event)
      )
        throw new WebhookError(400, 'Invalid GitHub delivery headers')
      const signal = AbortSignal.any([request.signal, deps.signal, AbortSignal.timeout(6500)])
      events = await normalizeGithubWebhook(
        repo,
        event,
        payload,
        () => deps.githubToken(settings.github.credentialRef, repo, signal),
        signal,
        undefined,
        deps.githubAppIdentity,
        ignored,
      )
    } else {
      events = ciFailure(repo, payload)
    }
    const stream = `github:${repo.name.toLowerCase()}`
    const start = deps.store.getStreamStartedAt(stream)
    if (deps.signal.aborted || !start)
      throw new WebhookError(503, 'Subscription changed; retry delivery')
    // GitHub timestamps are second-precision. Keep deliveries in the activation second.
    const since = Math.floor(Date.parse(start) / 1000) * 1000
    const currentEvents = events.filter((e) => Date.parse(e.occurredAt) >= since)
    if (
      !deps.store.commitPush({
        source: 'github',
        stream,
        revision,
        events: currentEvents,
        ignoredComments: ignored.filter((c) => Date.parse(c.occurredAt) >= since),
      })
    )
      throw new WebhookError(503, 'Subscription changed; retry delivery')
    deps.accepted(repo.name, currentEvents.length > 0)
    return Response.json({ status: currentEvents.length ? 'accepted' : 'ignored' })
  } catch (error) {
    if (error instanceof WebhookError)
      return Response.json({ error: error.message }, { status: error.status })
    if (error instanceof GithubWebhookPayloadError)
      return Response.json({ error: 'Invalid GitHub payload or repository' }, { status: 400 })
    // Upstream APIs, the vault and SQLite may include private details in errors.
    return Response.json({ error: 'Webhook temporarily unavailable' }, { status: 503 })
  }
}
