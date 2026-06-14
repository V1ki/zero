import { describe, expect, test } from 'bun:test'
import {
  SUPERVISOR_LABEL,
  getSupervisorLaunchAgentPaths,
  renderSupervisorLaunchAgentPlist,
} from '../system/launchd'

describe('launchd', () => {
  test('renders a LaunchAgent plist for the supervisor', () => {
    const paths = getSupervisorLaunchAgentPaths(
      '/tmp/zero-os',
      '/Users/tester',
      '/Users/tester/.bun/bin/bun',
    )
    const plist = renderSupervisorLaunchAgentPlist(paths)

    expect(plist).toContain(`<string>${SUPERVISOR_LABEL}</string>`)
    expect(plist).toContain('<key>ProgramArguments</key>')
    expect(plist).toContain('<string>/Users/tester/.bun/bin/bun</string>')
    expect(plist).toContain('<string>/tmp/zero-os/apps/supervisor/src/main.ts</string>')
    expect(plist).toContain('<key>WorkingDirectory</key>')
    expect(plist).toContain('<string>/tmp/zero-os</string>')
    expect(plist).toContain('<string>/tmp/zero-os/.zero/logs/supervisor.log</string>')
    expect(plist).toContain('<string>/tmp/zero-os/.zero/logs/supervisor.error.log</string>')
  })

  test('escapes xml-sensitive characters in generated plist values', () => {
    const paths = getSupervisorLaunchAgentPaths(
      '/tmp/zero & os',
      '/Users/test<er>',
      '/Users/test"er"/.bun/bin/bun',
    )
    const plist = renderSupervisorLaunchAgentPlist(paths)

    expect(plist).toContain('/tmp/zero &amp; os')
    expect(plist).toContain('<key>EnvironmentVariables</key>')
    expect(plist).toContain('/Users/test&lt;er&gt;')
    expect(plist).toContain('/Users/test&quot;er&quot;/.bun/bin/bun')
  })
})
