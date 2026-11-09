import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TriggerStore } from '@zero-os/observe'
import type { TriggerGithubRepository } from '@zero-os/shared'
import type { postGithubAppComment } from '../../triggers/github-app-comment'
import { runGithubCommand } from '../github'

let dir: string
let draft: string
let store: TriggerStore
const repository = 'Acme/Docs'
const ref = 'github_app_demo'
const body = 'First line.\n\n- More context\n'
const receipt = {
  id: 42,
  author: 'demo[bot]',
  url: 'https://github.com/Acme/Docs/issues/9#issuecomment-42',
}

function bind(changes: Partial<TriggerGithubRepository> = {}) {
  const { settings, revision } = store.getSettings()
  settings.github.repositories = [
    {
      name: repository,
      enabled: true,
      githubAppRef: ref,
      branch: '',
      workflow: '',
      mention: '',
      workflowFailures: false,
      ...changes,
    },
  ]
  store.saveSettings(settings, revision)
}
const args = () => ['reply', '--repo', 'acme/docs', '--number', '9', '--body-file', draft]
type Post = typeof postGithubAppComment
function mocked() {
  return {
    post: mock<Post>(async (_auth, request) => {
      request.beforePost?.()
      return receipt
    }),
    checkSecrets: mock(async (_body: string) => {}),
  }
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zero-github-reply-'))
  store = new TriggerStore(join(dir, 'listeners', 'inbox.sqlite'))
  bind()
  draft = join(dir, 'reply.md')
  writeFileSync(draft, body)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('posts one complete Markdown draft using the enabled repository’s app binding', async () => {
  const deps = mocked()
  expect(await runGithubCommand(dir, args(), deps)).toEqual(receipt)
  expect(deps.checkSecrets).toHaveBeenCalledWith(body)
  expect(deps.post).toHaveBeenCalledTimes(1)
  expect(deps.post.mock.calls[0]?.[1]).toMatchObject({
    ref,
    repository: 'acme/docs',
    issueNumber: 9,
    body,
  })
})

test('denies other, paused, and unbound repositories before accessing credentials', async () => {
  const deps = mocked()
  for (const changes of [{ name: 'Acme/Other' }, { enabled: false }, { githubAppRef: undefined }]) {
    bind(changes)
    await expect(runGithubCommand(dir, args(), deps)).rejects.toThrow('绑定 GitHub App')
  }
  expect(deps.checkSecrets).not.toHaveBeenCalled()
  expect(deps.post).not.toHaveBeenCalled()
})

test('does not send an empty draft, a blocked secret, or an ambiguous target', async () => {
  const deps = mocked()
  await expect(runGithubCommand(dir, [...args(), '--number', '10'], deps)).rejects.toThrow('Usage:')
  writeFileSync(draft, ' \n ')
  await expect(runGithubCommand(dir, args(), deps)).rejects.toThrow('非空')
  expect(deps.checkSecrets).not.toHaveBeenCalled()
  writeFileSync(draft, body)
  deps.checkSecrets.mockImplementation(async () => {
    throw new Error('secret blocked')
  })
  await expect(runGithubCommand(dir, args(), deps)).rejects.toThrow('secret blocked')
  expect(deps.post).not.toHaveBeenCalled()
})

test('rechecks a repository binding changed while obtaining the installation token', async () => {
  const deps = mocked()
  let sends = 0
  deps.post.mockImplementation(async (_auth, request) => {
    bind({ githubAppRef: 'github_app_replacement' })
    request.beforePost?.()
    sends++
    return receipt
  })
  await expect(runGithubCommand(dir, args(), deps)).rejects.toThrow('绑定已改变')
  expect(sends).toBe(0)
})

test('passes the pushed branch, base and complete draft through the bound App PR command', async () => {
  const deps = mocked()
  const openPull = mock<typeof import('../../triggers/github-app-pull').openGithubAppPull>(
    async (_, input) => {
      input.beforeWrite()
      return {
        status: 'created',
        url: 'https://github.com/Acme/Docs/pull/27',
        number: 27,
        author: 'demo[bot]',
        head: 'a'.repeat(40),
      }
    },
  )
  const args = [
    'open-pr',
    '--repo',
    repository,
    '--head',
    'fix/image',
    '--base',
    'main',
    '--title',
    'Show images',
    '--body-file',
    draft,
  ]
  expect(await runGithubCommand(dir, args, { ...deps, openPull })).toMatchObject({
    author: 'demo[bot]',
    number: 27,
  })
  expect(deps.checkSecrets).toHaveBeenCalledWith('Show images\n' + body)
  expect(openPull).toHaveBeenCalledTimes(1)
  expect(openPull.mock.calls[0]?.[1]).toMatchObject({
    ref,
    repository,
    head: 'fix/image',
    base: 'main',
    body,
  })
  expect(deps.post).not.toHaveBeenCalled()
})

test('publishes a reviewed SHA from the named source under the current App binding', async () => {
  const publishBranch = mock<
    typeof import('../../triggers/github-app-branch').publishGithubAppBranch
  >(async (_, input) => {
    input.beforeWrite()
    return {
      repository: input.repository,
      branch: input.branch,
      head: input.head,
      app: 'demo[bot]',
      url: 'https://github.com/Acme/Docs/tree/review/docs',
      status: 'published',
    }
  })
  const options = [
    'publish-branch',
    '--repo',
    repository,
    '--source',
    '/tmp/test.bundle',
    '--branch',
    'review/docs',
    '--head',
    'a'.repeat(40),
  ]
  expect(await runGithubCommand(dir, options, { ...mocked(), publishBranch })).toMatchObject({
    head: 'a'.repeat(40),
    status: 'published',
  })
  expect(publishBranch.mock.calls[0][1]).toMatchObject({
    ref,
    source: '/tmp/test.bundle',
    branch: 'review/docs',
  })
})
