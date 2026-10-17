import { ADVANCED_CASES } from './advanced'
import { AGENT_CASES, CLOSURE_CASES } from './cases'
import { getRealSuite } from './real'

export type SuiteName = 'basic' | 'advanced' | 'real'

export function getSuite(name: SuiteName = 'basic') {
  if (name === 'basic') return { agent: AGENT_CASES, closure: CLOSURE_CASES }
  if (name === 'advanced') return { agent: ADVANCED_CASES, closure: [] }
  if (name === 'real') return getRealSuite()
  throw new Error(`Unknown suite: ${name}`)
}
