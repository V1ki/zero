/** Point back to the exact control the reader used, including the current event or matter selection. */
export function workspaceTraceLink(parameters: Record<string, string>, anchor: string) {
  const search = new URLSearchParams(parameters)
  search.set('returnTo', window.location.pathname + window.location.search + '#' + anchor)
  return '/router/traces?' + search
}
export function workspaceReturnLink() {
  const value = new URLSearchParams(window.location.search).get('returnTo')
  if (!value || !(value.startsWith('/router?') || value.startsWith('/router#'))) return
  const url = new URL(value, window.location.origin)
  if (
    url.origin === window.location.origin &&
    url.pathname === '/router' &&
    /^#rw-[a-zA-Z0-9-]+$/.test(url.hash)
  )
    return url.pathname + url.search + url.hash
}

export function restoreWorkspaceAnchor(node: HTMLElement | null) {
  if (!node || location.hash !== '#' + node.id || node.dataset.restored) return
  node.dataset.restored = 'true'
  let details = node.closest('details')
  while (details) {
    details.open = true
    details = details.parentElement?.closest('details') ?? null
  }
  node.focus({ preventScroll: true })
  node.scrollIntoView({ block: 'center' })
}
