/**
 * Tier 2: Interactive Element scenarios.
 * Tests form filling, search interaction, and element manipulation.
 */

import type { Scenario } from './index'

export const interactiveScenarios: Scenario[] = [
  {
    id: 'I1',
    name: 'Form Fill — httpbin',
    tier: 'interactive',
    url: 'https://httpbin.org/forms/post',
    description: 'Snapshot interactive elements, fill form fields, and submit.',
    expectations: [
      {
        text: 'All form fields identified in snapshot',
        check: (outputs) => {
          const snap = outputs.get('snapshot')
          // httpbin form has: custname, custtel, custemail, size (radio), topping (checkbox), delivery, comments
          const output = snap?.output ?? ''
          const hasInputRefs = (output.match(/\be\d+\b|@e\d+/g) ?? []).length >= 4
          return {
            passed: hasInputRefs,
            evidence: `Found ${(output.match(/\be\d+\b|@e\d+/g) ?? []).length} element refs`,
          }
        },
      },
      {
        text: 'Fill commands succeed for text fields',
        check: (outputs) => {
          const fill1 = outputs.get('fill_name')
          const fill2 = outputs.get('fill_email')
          const bothOk = fill1?.success && fill2?.success
          return {
            passed: bothOk === true,
            evidence: bothOk
              ? 'Both fill commands succeeded'
              : `name: ${fill1?.success}, email: ${fill2?.success}`,
          }
        },
      },
      {
        text: 'Form submission returns success',
        check: (outputs) => {
          const submit = outputs.get('submit')
          return {
            passed: submit?.success === true,
            evidence: submit?.success ? 'Submit succeeded' : `Failed: ${submit?.error}`,
          }
        },
      },
    ],
    run: async (driver) => {
      const outputs = new Map()
      outputs.set('navigate', await driver.navigate('https://httpbin.org/forms/post'))
      const snap = await driver.snapshot({ interactive: true })
      outputs.set('snapshot', snap)

      // Parse element refs from snapshot to find input fields
      const refs = parseRefs(snap.output, driver.name)

      // Fill text fields (use first two text input refs found)
      if (refs.length >= 2) {
        outputs.set('fill_name', await driver.fill(refs[0], 'Test User'))
        outputs.set('fill_email', await driver.fill(refs[1], 'test@test.com'))
      } else {
        outputs.set('fill_name', {
          success: false,
          output: '',
          duration_ms: 0,
          error: `Only ${refs.length} refs found`,
        })
        outputs.set('fill_email', {
          success: false,
          output: '',
          duration_ms: 0,
          error: 'Insufficient refs',
        })
      }

      // Find and click submit button
      const submitRef = findSubmitRef(snap.output, driver.name)
      if (submitRef) {
        outputs.set('submit', await driver.click(submitRef))
      } else {
        outputs.set('submit', {
          success: false,
          output: '',
          duration_ms: 0,
          error: 'Submit button not found',
        })
      }

      return outputs
    },
  },

  {
    id: 'I2',
    name: 'Search Interaction — DuckDuckGo',
    tier: 'interactive',
    url: 'https://duckduckgo.com',
    description: 'Fill search box, submit, and verify results load.',
    expectations: [
      {
        text: 'Search input found in snapshot',
        check: (outputs) => {
          const snap = outputs.get('snapshot')
          const output = snap?.output?.toLowerCase() ?? ''
          const hasSearch =
            output.includes('search') || output.includes('textbox') || output.includes('input')
          return {
            passed: hasSearch,
            evidence: hasSearch ? 'Search input identified' : 'No search input found',
          }
        },
      },
      {
        text: 'Search text entered successfully',
        check: (outputs) => {
          const fill = outputs.get('fill_search')
          return {
            passed: fill?.success === true,
            evidence: fill?.success ? 'Fill succeeded' : `Failed: ${fill?.error}`,
          }
        },
      },
      {
        text: 'Results page loads after submission',
        check: (outputs) => {
          const results = outputs.get('results_snapshot')
          const output = results?.output ?? ''
          // Results page should have more elements than the search page
          const refCount = (output.match(/\be\d+\b|@e\d+/g) ?? []).length
          return {
            passed: refCount > 5,
            evidence: `Results page has ${refCount} element refs`,
          }
        },
      },
    ],
    run: async (driver) => {
      const outputs = new Map()
      outputs.set('navigate', await driver.navigate('https://duckduckgo.com'))
      const snap = await driver.snapshot({ interactive: true })
      outputs.set('snapshot', snap)

      // Find search input ref
      const searchRef = findSearchRef(snap.output, driver.name)
      if (searchRef) {
        outputs.set('fill_search', await driver.fill(searchRef, 'TypeScript programming'))
        outputs.set('press_enter', await driver.press(searchRef, 'Enter'))
        // Wait for results to load
        await Bun.sleep(2000)
        outputs.set('results_snapshot', await driver.snapshot({ interactive: true }))
      } else {
        const noRef = { success: false, output: '', duration_ms: 0, error: 'Search ref not found' }
        outputs.set('fill_search', noRef)
        outputs.set('press_enter', noRef)
        outputs.set('results_snapshot', noRef)
      }

      return outputs
    },
  },
]

/** Extract element refs from snapshot output */
function parseRefs(output: string, driverName: string): string[] {
  if (!output) return []

  if (driverName === 'agent-browser') {
    // agent-browser uses @eN format — return without @ prefix for the driver API
    const matches = output.match(/@e(\d+)/g) ?? []
    return matches.map((m) => m.slice(1)) // remove @ → "e0", "e1"
  }

  // PinchTab uses eN format
  const matches = output.match(/\be(\d+)\b/g) ?? []
  return [...new Set(matches)] // deduplicate
}

/** Find submit button ref in snapshot */
function findSubmitRef(output: string, driverName: string): string | null {
  if (!output) return null
  const lines = output.split('\n')

  for (const line of lines) {
    const lower = line.toLowerCase()
    if (lower.includes('submit') || lower.includes('button')) {
      const refMatch =
        driverName === 'agent-browser' ? line.match(/@(e\d+)/) : line.match(/\b(e\d+)\b/)
      if (refMatch) return refMatch[1]
    }
  }
  return null
}

/** Find search input ref in snapshot */
function findSearchRef(output: string, driverName: string): string | null {
  if (!output) return null
  const lines = output.split('\n')

  for (const line of lines) {
    const lower = line.toLowerCase()
    if (lower.includes('search') || lower.includes('textbox') || lower.includes('combobox')) {
      const refMatch =
        driverName === 'agent-browser' ? line.match(/@(e\d+)/) : line.match(/\b(e\d+)\b/)
      if (refMatch) return refMatch[1]
    }
  }
  return null
}
