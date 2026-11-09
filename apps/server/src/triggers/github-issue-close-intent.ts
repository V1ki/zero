import type { TriggerInboxItem } from '@zero-os/shared'

// A positive, complete imperative. A question, code/example, quotation, qualifier,
// different issue number, URL or additional instruction cannot authorize this write.
export function requestsCurrentIssueClose(text: string, event: TriggerInboxItem): boolean {
  if (event.source !== 'github' || !event.url || text.length > 192) return false
  const target =
    /^https:\/\/github\.com\/([a-z0-9-]+\/[a-z0-9_.-]+)\/issues\/([1-9]\d*)(?:#issuecomment-[1-9]\d*)?$/iu.exec(
      event.url,
    )
  if (!target || target[1].toLowerCase() !== event.scope.toLowerCase()) return false
  const words = text
    .normalize('NFKC')
    .trim()
    .replace(/[。.!！]+$/u, '')
    .replace(/(?:一下|了)?(?:吧|一下)$/u, '')
    .trim()
  if (!words || /[\r\n]/u.test(words)) return false
  const close =
    /^(?:(?:请你?|麻烦|帮我|现在|直接)\s*){0,4}(?:关闭|关掉|关上|关一下)\s*((?:这个|这条|当前(?:的)?|该|本)\s*)?(?:(issue|议题|问题)\s*)?(?:#\s*([1-9]\d*))?$/iu.exec(
      words,
    ) ??
    /^(?:please\s+)?close\s+(?:(this|the current|current|the)\s*)?(?:(issue)\s*)?(?:#\s*([1-9]\d*))?$/iu.exec(
      words,
    ) ??
    /^(?:(?:请你?|麻烦|帮我|现在|直接)\s*){0,4}(?:把|将)\s*((?:这个|这条|当前(?:的)?|该|本)\s*)?(?:(issue|议题|问题)\s*)?(?:#\s*([1-9]\d*))?\s*(?:关闭|关掉|关了|关一下|关)$/iu.exec(
      words,
    )
  return !!close && (!!close[2] || !!close[3]) && (!close[3] || close[3] === target[2])
}
