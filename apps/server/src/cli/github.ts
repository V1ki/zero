import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { OutputSecretFilter, loadVault } from '@zero-os/secrets'
import { triggerGithubAppRefPattern } from '@zero-os/shared'
import { createVaultGithubAppAuth } from '../triggers/github-app-auth'
import { postGithubAppComment } from '../triggers/github-app-comment'
import { openGithubAppPull } from '../triggers/github-app-pull'
import { mergeGithubAppPull } from '../triggers/github-app-merge'
import { publishGithubAppBranch } from '../triggers/github-app-branch'

const usage =
  'Usage: bun zero github identity --repo OWNER/REPO | reply --repo OWNER/REPO --number N --body-file PATH | publish-branch --repo OWNER/REPO --source PATH --branch BRANCH --head SHA | open-pr --repo OWNER/REPO --head BRANCH --base BRANCH --title TEXT --body-file PATH | merge --repo OWNER/REPO --number N --head SHA'

/** Read the saved binding without creating or migrating a listener database. */
function currentAppRef(zeroDir: string, repository: string) {
  const path = join(zeroDir, 'listeners', 'inbox.sqlite')
  if (!existsSync(path)) throw new Error('请先启用目标仓库的监听并绑定 GitHub App。')
  const db = new Database(path, { readonly: true })
  try {
    const row = db
      .query<{ ref: string | null }, [string]>(
        `SELECT json_extract(repo.value, '$.githubAppRef') AS ref
         FROM trigger_settings AS s, json_each(s.json, '$.github.repositories') AS repo
         WHERE s.id=1 AND json_extract(repo.value, '$.enabled')=1
           AND json_extract(repo.value, '$.name')=? COLLATE NOCASE`,
      )
      .get(repository)
    if (!row?.ref || !triggerGithubAppRefPattern.test(row.ref)) {
      throw new Error('请先启用目标仓库的监听并绑定 GitHub App。')
    }
    return row.ref
  } finally {
    db.close()
  }
}

export async function runGithubCommand(
  zeroDir: string,
  [command, ...args]: string[],
  deps: {
    post: typeof postGithubAppComment
    openPull?: typeof openGithubAppPull
    publishBranch?: typeof publishGithubAppBranch
    checkSecrets: (text: string) => Promise<void>
  } = {
    post: postGithubAppComment,
    checkSecrets: async (body: string) => {
      const vault = await loadVault(join(zeroDir, 'secrets.enc'))
      if (
        new OutputSecretFilter(vault.entries()).filter(body) !== body ||
        /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u.test(body)
      )
        throw new Error('公开正文含凭据，请移除后再发送。')
    },
  },
) {
  const { values, tokens } = parseArgs({
    args,
    tokens: true,
    options: {
      head: { type: 'string' },
      branch: { type: 'string' },
      source: { type: 'string' },
      base: { type: 'string' },
      title: { type: 'string' },
      repo: { type: 'string' },
      number: { type: 'string' },
      'body-file': { type: 'string' },
    },
  })
  const repository = values.repo
  const issueNumber = Number(values.number)
  const file = values['body-file']
  if (
    !repository ||
    !/^[a-z0-9-]+\/[a-z0-9._-]+$/iu.test(repository) ||
    /\/\.{1,2}$/u.test(repository)
  )
    throw new Error(usage)
  const auth = createVaultGithubAppAuth(zeroDir)
  const signal = AbortSignal.timeout(45_000)
  if (command === 'identity' && tokens.length === 1)
    return auth.inspectInstallation(currentAppRef(zeroDir, repository), repository, signal)
  const open =
    command === 'open-pr' &&
    tokens.length === 5 &&
    values.head &&
    values.base &&
    values.title?.trim() &&
    file
  const publish =
    command === 'publish-branch' &&
    tokens.length === 4 &&
    values.source &&
    values.branch &&
    values.head
  if (
    !open &&
    !publish &&
    (tokens.length !== 3 ||
      !/^[1-9]\d*$/u.test(values.number ?? '') ||
      !Number.isSafeInteger(issueNumber))
  )
    throw new Error(usage)
  const ref = currentAppRef(zeroDir, repository)
  const beforeWrite = () => {
    if (currentAppRef(zeroDir, repository) !== ref)
      throw new Error('GitHub App 绑定已改变，请重新核对。')
  }
  if (publish && command === 'publish-branch' && values.source && values.head && values.branch)
    return (deps.publishBranch ?? publishGithubAppBranch)(auth, {
      ref,
      repository,
      source: values.source,
      head: values.head,
      branch: values.branch,
      signal,
      beforeWrite,
    })
  if (command === 'merge' && values.head && /^[0-9a-f]{40}$/u.test(values.head))
    return mergeGithubAppPull(auth, {
      ref,
      repository,
      number: issueNumber,
      head: values.head,
      signal,
      beforeWrite,
    })
  if ((!open && command !== 'reply') || !file) throw new Error(usage)
  const draft = Bun.file(file)
  if (draft.size > 4 * 65536) throw new Error('公开正文过长。')
  const body = new TextDecoder('utf-8', { fatal: true }).decode(await draft.arrayBuffer())
  if (!body.trim() || body.length > 65536 || body.includes('\0'))
    throw new Error('公开正文必须是 1 至 65536 字符的非空文本。')
  if (open && values.head && values.base && values.title) {
    await deps.checkSecrets([values.title, body].join('\n'))
    return (deps.openPull ?? openGithubAppPull)(auth, {
      ref,
      repository,
      head: values.head,
      base: values.base,
      title: values.title,
      body,
      signal,
      beforeWrite,
    })
  }
  await deps.checkSecrets(body)
  return deps.post(auth, {
    ref,
    repository,
    issueNumber,
    body,
    signal,
    beforePost: beforeWrite,
  })
}
