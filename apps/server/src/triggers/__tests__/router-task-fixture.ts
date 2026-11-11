import { expect } from 'bun:test'
import type { TriggerStore } from '@zero-os/observe'
import type { TriggerMandate } from '@zero-os/shared'

export const taskRepository = 'v1ki/zero'

export const githubMandate: TriggerMandate = {
  id: 'release-ci',
  name: '发布流水线跟踪',
  purpose: '发布工作流失败时找出原因',
  source: 'github',
  scope: taskRepository,
  groupBy: 'mandate',
  keyword: '',
  enabled: true,
  projectId: null,
  targets: [],
  archive: null,
  policy: { duringWork: 'web' },
  deadline: null,
  urgent: false,
}

/**
 * Subscribes the store to one GitHub repository and one WXARC room, adds a GitHub and a WXARC
 * mandate, and lets one event of each match and finish its analysis with `summary`.
 */
export function addTasks(store: TriggerStore, summary = 'release.yml 在 Run tests 一步失败') {
  const revision = store.saveSettings(
    {
      github: {
        credentialRef: '',
        repositories: [
          {
            name: taskRepository,
            enabled: true,
            workflowFailures: true,
            branch: '',
            workflow: '',
            mention: '',
          },
        ],
      },
      wxarc: { sessions: [{ id: 'team-room', name: '测试会话', keyword: '', enabled: true }] },
    },
    store.getSettings().revision,
  )
  const routing = store.routing.getSettings()
  store.routing.saveSettings({ ...routing.settings, enabled: true }, routing.revision)
  const room: TriggerMandate = { ...githubMandate, id: 'room', source: 'wxarc', scope: 'team-room' }
  store.mandates.saveSettings(
    { projects: [], mandates: [githubMandate, room] },
    store.mandates.getSettings().revision,
  )
  for (const [source, scope] of [
    ['github', taskRepository],
    ['wxarc', 'team-room'],
  ] as const) {
    expect(
      store.commitPush({
        source,
        stream: `${source}:${scope}`,
        revision,
        events: [
          {
            scope,
            eventId: source === 'github' ? '1:run:2:1:failure' : 'message-1',
            title: '发布失败',
            summary: '工作流失败',
            occurredAt: '2026-11-04T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(true)
    const work = store.mandates.claimAnalysis(`fixture-${source}`)
    if (!work) throw new Error('Expected a match to analyze')
    expect(store.mandates.finishAnalysis(work.match.id, summary, work.claimToken)).toBe(true)
  }
  const tasks = store.mandates.listTasks()
  const github = tasks.find((task) => task.mandateId === githubMandate.id)
  const wxarc = tasks.find((task) => task.mandateId === room.id)
  if (!github || !wxarc) throw new Error('Expected both tasks')
  return {
    github: github.id,
    wxarc: wxarc.id,
    githubScope: `task-${github.id}` as const,
    wxarcScope: `task-${wxarc.id}` as const,
    /** Disables the GitHub mandate, which makes its task inactive. */
    stopGithub() {
      store.mandates.saveSettings(
        { projects: [], mandates: [{ ...githubMandate, enabled: false }, room] },
        store.mandates.getSettings().revision,
      )
    },
  }
}
