import { expect, mock, test } from 'bun:test'
import { TriggerStore } from '@zero-os/observe'
import { RouterGithubReplies } from '../router-github-reply'
import { createRouterRepositoryLookup } from '../router-repositories'
import { createRouterWorkerCapabilities } from '../router-worker-capabilities'

test('only a user-directed Codex job receives its configured App commands; a source grant distinguishes investigating from closing', async () => {
  const store = new TriggerStore(':memory:')
  const signal = new AbortController().signal
  const denied = async (): Promise<never> => {
    throw Error('Unexpected write')
  }
  try {
    const repository = 'fixture/repo'
    const revision = store.saveSettings(
      {
        github: {
          credentialRef: '',
          repositories: [
            {
              name: repository,
              enabled: true,
              issues: true,
              issueComments: true,
              ownerMentionReplies: true,
              allowOwnerIssueClose: true,
              githubAppRef: 'github_app_fixture',
              workflowFailures: false,
              workflow: '',
              branch: '',
              mention: '',
            },
          ],
        },
        wxarc: { sessions: [] },
      },
      0,
    )
    const eventId = '123:comment:45'
    store.commitPush({
      source: 'github',
      stream: `github:${repository}`,
      revision,
      events: [
        {
          eventId,
          scope: repository,
          occurredAt: new Date(Date.now() + 1000).toISOString(),
          title: 'Issue 评论',
          summary: '请核对现象',
          url: 'https://github.com/fixture/repo/issues/10#issuecomment-45',
          githubCommentKind: 'issue-comment',
        },
      ],
    })
    const event = store.listInbox()[0]
    const matter = store.ledger.createMatter('router-owner', '核对', '核对原文', ['给出证据'])
    const job = (authority: 'source' | 'user') => {
      const j = store.jobs.submit('general', authority, {
        executor: 'codex',
        repository,
        instruction: '核对',
        audience: 'fixture',
      })
      store.ledger.bindWorker({
        principal: 'router-owner',
        matterId: matter.id,
        jobId: j.id,
        scope: 'general',
        authority,
        audience: 'fixture',
        eventIds: [event.id],
      })
      return j
    }
    let closeApproved = false
    const closeIssue = mock(denied)
    const build = createRouterWorkerCapabilities({
      store,
      cliProjectDir: '/opt/zero',
      authorized: () => true,
      investigator: {
        available: () => [],
        inspect: async (item) => ({
          kind: 'issue',
          observedAt: item.occurredAt,
          sourceUrl: item.url!,
          facts: [{ label: '原文', value: item.summary }],
        }),
      },
      repositories: createRouterRepositoryLookup(
        () => null,
        () => undefined,
      ),
      closeIssue,
      replies: new RouterGithubReplies(
        store,
        { getCommentAccess: denied, getCommentIdentity: denied },
        (s) => s,
      ),
      ownerRequest: async () => ({
        instruction: '负责人请求',
        ...(closeApproved && { closeIssue: true as const }),
      }),
    })
    const source = job('source')
    const read = await build(source, signal)
    expect(read.context.githubApp).toBeUndefined()
    expect(read.capabilities.map((c) => c.definition.name)).toContain('reply_original_discussion')
    expect(read.capabilities.map((c) => c.definition.name)).not.toContain('close_source_issue')
    closeApproved = true
    const close = (await build(source, signal)).capabilities.find(
      (c) => c.definition.name === 'close_source_issue',
    )
    expect(close).toBeDefined()
    closeApproved = false
    await expect(Promise.resolve(close!.execute({ eventId: event.id }, signal))).rejects.toThrow(
      '关闭授权',
    )
    expect(closeIssue).not.toHaveBeenCalled()
    const own = job('user')
    const granted = await build(own, signal)
    expect(granted.context.githubApp).toMatchObject({
      repository,
      workingDirectory: '/opt/zero',
      identity: ['bun', 'zero', 'github', 'identity', '--repo', repository],
      openPullRequest: expect.arrayContaining(['open-pr', repository]),
      merge: [
        'bun',
        'zero',
        'github',
        'merge',
        '--repo',
        repository,
        '--number',
        'N',
        '--head',
        'REVIEWED_HEAD_SHA',
      ],
    })
    expect(JSON.stringify(granted.context.githubApp)).not.toContain('github_app_fixture')
    expect((await build({ ...own, executor: 'zero' }, signal)).context.githubApp).toBeUndefined()
    const related = store.ledger.createMatter('router-owner', '另件事', '读补充资料', ['读取原文'])
    store.commitPush({
      source: 'github',
      stream: 'github:' + repository,
      revision,
      events: [
        {
          eventId: 'related-2',
          scope: repository,
          title: '额外资料',
          summary: '仪器记录 A19',
          url: 'https://github.com/fixture/repo/issues/11',
          occurredAt: new Date().toISOString(),
        },
      ],
    })
    const extra = store.listInbox()[0]
    store.ledger.changeSourceAssociation(
      'router-owner',
      extra.id,
      undefined,
      matter.id,
      '同一任务的补充证据',
    )
    const next = await build(own, signal)
    expect(next.context.sources.find((e) => e.id === extra.id)?.assignedToWorker).toBe(false)
    const readExtra = next.capabilities.find((c) => c.definition.name === 'read_source')!
    expect(await readExtra.execute({ eventId: extra.id }, signal)).toMatchObject({
      facts: [{ value: '仪器记录 A19' }],
    })
    const reply = next.capabilities.find((c) => c.definition.name === 'reply_original_discussion')!
    await expect(
      Promise.resolve(reply.execute({ eventId: extra.id, text: '测试' }, signal)),
    ).rejects.toThrow('关联')
    store.ledger.changeSourceAssociation(
      'router-owner',
      extra.id,
      matter.id,
      related.id,
      '关联纠正',
    )
    await expect(Promise.resolve(readExtra.execute({ eventId: extra.id }, signal))).rejects.toThrow(
      '关联',
    )
    const afterCorrection = await build(own, signal)
    expect(afterCorrection.context.removedSourceEventIds).toContain(extra.id)
    expect(afterCorrection.context.sources.some((e) => e.id === extra.id)).toBe(false)
  } finally {
    store.close()
  }
})
