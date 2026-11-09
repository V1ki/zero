import type { RouterLedgerStore } from '@zero-os/observe'
import type { RouterTraceSink } from '@zero-os/shared'

/** Filter at the persistence boundary, including nested tool arguments and output strings. */
export function createRouterTraceSink(
  store: RouterLedgerStore,
  filter: (text: string) => string,
  replayOf?: string,
): RouterTraceSink {
  const privateKey =
    /^(authorization|cookie|password|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|thinking|reasoning)$/i
  function redact(value: unknown): unknown {
    if (typeof value === 'string') {
      const filtered = filter(value)
      if (/^[\s]*[\[{]/.test(filtered)) {
        try {
          return JSON.stringify(redact(JSON.parse(filtered)))
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
      return filtered
    }
    if (Array.isArray(value))
      return value
        .filter(
          (v) =>
            !(
              v &&
              typeof v === 'object' &&
              'type' in v &&
              ['thinking', 'redacted_thinking', 'reasoning'].includes(String(v.type))
            ),
        )
        .map(redact)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, v]) => [
          key,
          privateKey.test(key) ? '[REDACTED]' : redact(v),
        ]),
      )
    return value
  }
  return {
    begin: (session, label, input) => {
      const id = store.begin(session, label, redact(input), replayOf)
      const worker = /^router-job-([1-9]\d*)$/.exec(session)
      const link = worker && store.workerLink(Number(worker[1]))
      if (link) store.referenceMatter(id, link.matterId)
      return id
    },
    append: (run, kind, data) => {
      store.append(run, kind, redact(data))
      if (kind !== 'tool_result' || !data || typeof data !== 'object') return
      const item = data as {
        input?: Record<string, unknown>
        result?: { success?: boolean; output?: string }
      }
      if (!item.result?.success) return
      if (typeof item.input?.matterId === 'string') store.referenceMatter(run, item.input.matterId)
      if (item.result.output) {
        try {
          const result = JSON.parse(item.result.output)
          if (
            result &&
            typeof result === 'object' &&
            typeof result.id === 'string' &&
            typeof result.goal === 'string' &&
            Array.isArray(result.criteria)
          )
            store.referenceMatter(run, result.id)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
    },
    end: (run, status) => store.end(run, status),
  }
}
