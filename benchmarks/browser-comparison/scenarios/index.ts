/**
 * Scenario registry — aggregates all test scenarios for the benchmark.
 */

import type { BrowserDriver, DriverResult } from '../drivers/base'

export interface Expectation {
  text: string
  check: (outputs: Map<string, DriverResult>) => { passed: boolean; evidence: string }
}

export interface Scenario {
  id: string
  name: string
  tier: 'static' | 'interactive' | 'spa' | 'stealth'
  url: string
  description: string
  expectations: Expectation[]
  run: (driver: BrowserDriver) => Promise<Map<string, DriverResult>>
}

export { staticScenarios } from './static'
export { interactiveScenarios } from './interactive'
export { spaScenarios } from './spa'
export { stealthScenarios } from './stealth'

import { interactiveScenarios } from './interactive'
import { spaScenarios } from './spa'
import { staticScenarios } from './static'
import { stealthScenarios } from './stealth'

export const allScenarios: Scenario[] = [
  ...staticScenarios,
  ...interactiveScenarios,
  ...spaScenarios,
  ...stealthScenarios,
]
