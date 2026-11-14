import type { AgentDependencies } from '../event-agent'

/** For tests that do not look at the event files Router model calls write. */
export const discardedEvents: AgentDependencies['sessionEvents'] = {
  append: () => null,
  appendMessage: () => {},
  registerSubagent: () => null,
  release: () => {},
}
