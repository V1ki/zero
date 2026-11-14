import type { AgentDependencies } from '../event-agent'

/** For tests that do not look at the event files Router model calls write. */
export const discardedEvents: AgentDependencies['sessionEvents'] = {
  openRun: () => ({ logFile: '', append: () => null, appendMessage: () => {} }),
}
