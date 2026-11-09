import {
  type TriggerGithubRepository,
  type TriggerInboxItem,
  githubLifecycleKind,
  triggerGithubAppRefPattern,
} from './trigger'

/** Immutable discussion reference from GitHub's adapter metadata. Grants no write authority. */
export function githubDiscussionSubject(event: TriggerInboxItem | null) {
  if (event?.source !== 'github' || !event.url) return null
  // Match the original string: do not accept redirects, dot-segments, encoded separators or credentials.
  const url =
    /^https:\/\/github\.com\/([a-z\d-]+\/[a-z\d_.-]+)\/(issues|pull)\/([1-9]\d*)(?:#issuecomment-([1-9]\d*))?$/iu.exec(
      event.url,
    )
  if (
    !url ||
    url[0] !== event.url ||
    url[1].toLowerCase() !== event.scope.toLowerCase() ||
    /\/\.{1,2}$/u.test(url[1])
  )
    return null
  const number = Number(url[3])
  const kind = url[2] === 'issues' ? ('issue' as const) : url[2] === 'pull' ? ('pr' as const) : null
  const [repositoryId, type, item] = event.eventId.split(':')
  if (!kind || !Number.isSafeInteger(number) || !Number.isSafeInteger(Number(repositoryId)))
    return null
  if (type === 'comment') {
    const comment = /^([1-9]\d*):comment:([1-9]\d*)$/u.exec(event.eventId)
    if (
      !comment ||
      comment[0] !== event.eventId ||
      comment[2] !== url[4] ||
      !Number.isSafeInteger(Number(item))
    )
      return null
    // Before ordinary comment tracking, the PR @mention adapter had no comment-kind field.
    if (event.githubCommentKind ? event.githubCommentKind !== `${kind}-comment` : kind !== 'pr')
      return null
  } else if (
    url[4] ||
    event.githubCommentKind ||
    githubLifecycleKind(event.eventId) !== kind ||
    item !== url[3]
  )
    return null
  return {
    repositoryId: Number(repositoryId),
    number,
    kind,
  }
}

/** Writing additionally requires the repository's currently enabled App binding. */
export function githubReplySubject(
  event: TriggerInboxItem | null,
  repos: TriggerGithubRepository[],
) {
  const subject = githubDiscussionSubject(event)
  if (!event || !subject) return null
  const repo = repos.find((r) => r.enabled && r.name.toLowerCase() === event.scope.toLowerCase())
  const ref = repo?.githubAppRef
  if (!repo || !ref || !triggerGithubAppRefPattern.test(ref)) return null
  return {
    ...subject,
    ref,
    repository: repo.name,
    url: `https://github.com/${repo.name}/${subject.kind === 'pr' ? 'pull' : 'issues'}/${subject.number}`,
  }
}
