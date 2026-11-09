import { isUnsafeGithubComment } from './github-comment-safety'

// Only changed lines from small docs/source/test changes are eligible. Paths and patch text are
// untrusted data. Skip an entire file on sensitive material rather than quoting nearby lines.
const reviewablePath =
  /^(?:README(?:[._-][\w-]+)?\.md|CHANGELOG\.md|(?:docs|src|test|tests)\/[\w./-]+\.(?:md|txt|tsx?|jsx?|py|go|rs|swift|java|css))$/i
const sensitivePath =
  /(?:^|[/._-])(?:auth(?:entication|orization)?|secrets?|credentials?|tokens?|keys?|oauth|passwords?|certs?|ssh|crypto|sessions?|vault|security|permissions?|vendor|generated)(?:$|[/._-])/i
const sensitiveText =
  /(?:-----BEGIN|password|passwd|credential|authorization|cookie[=:\s]|bearer\s|(?:api|private)[_-]?key|secret|token|:\/\/[^\s/]+:[^\s/]+@|私钥|密钥|密码|令牌|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b)/i

export function smallPullChangeLines(
  file: Record<string, unknown>,
  clean: (value: unknown) => string,
): string | undefined {
  const paths = [file.filename]
  if (file.status === 'renamed') paths.push(file.previous_filename)
  if (
    !paths.every(
      (path) =>
        typeof path === 'string' &&
        reviewablePath.test(path) &&
        !path.split('/').some((part) => !part || part.startsWith('.')) &&
        !sensitivePath.test(path),
    ) ||
    typeof file.patch !== 'string' ||
    file.patch.length > 12_000 ||
    /-----BEGIN[ A-Z]+KEY-----|(?:password|secret|token|credential|api[_-]?key)["']?\s*[:=]/i.test(
      file.patch,
    )
  )
    return
  const { additions, deletions } = file
  if (
    typeof additions !== 'number' ||
    !Number.isSafeInteger(additions) ||
    additions < 0 ||
    typeof deletions !== 'number' ||
    !Number.isSafeInteger(deletions) ||
    deletions < 0 ||
    additions + deletions > 60
  )
    return
  const patch = file.patch.replaceAll('\r\n', '\n').split('\n')
  if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(patch[0])) return
  const changes = patch.filter((line) => line.startsWith('+') || line.startsWith('-'))
  if (!changes.length || changes.length > additions + deletions) return
  const docs = typeof file.filename === 'string' && /\.(md|txt)$/i.test(file.filename)
  const excerpts = changes
    .slice(0, 6)
    .map((line) =>
      docs
        ? line
            .replace(/\[([^\]\n]*)\]\(https?:\/\/[^)\s]+\)/gi, '$1')
            .replace(/https?:\/\/[^\s>)]+/gi, '[链接]')
        : line,
    )
  if (
    excerpts.some(
      (line) =>
        sensitiveText.test(line) ||
        isUnsafeGithubComment(line) ||
        /\p{C}/u.test(line.replaceAll('\t', ' ')) ||
        // Long lowercase slugs commonly identify projects in Markdown links.
        (line.match(/[A-Za-z0-9+/=_-]{28,}/g) ?? []).some(
          (word) => !/^[a-z]+(?:-[a-z]+)+$/.test(word),
        ),
    )
  )
    return
  const longLines = excerpts.some((line) => line.length > 150)
  if (!docs && longLines) return
  const note = longLines ? '（长文档行仅显示开头）' : ''
  return `增删行节选 ${excerpts.length}/${additions + deletions} 行${note}\n${excerpts.map(clean).join('\n')}`
}
