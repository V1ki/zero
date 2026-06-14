import { toErrorMessage } from '@zero-os/shared'
import {
  getSupervisorLaunchAgentStatus,
  installSupervisorLaunchAgent,
  uninstallSupervisorLaunchAgent,
} from '../system/launchd'

export async function runLaunchctlCommand(args: string[]): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('[ZeRo OS] launchctl integration is only available on macOS.')
    process.exit(1)
  }

  const action = args[0] ?? 'install'

  try {
    switch (action) {
      case 'install': {
        const launchAgent = installSupervisorLaunchAgent()
        console.log('[ZeRo OS] Supervisor LaunchAgent installed.')
        console.log(`  Label: ${'com.zero-os.supervisor'}`)
        console.log(`  Plist: ${launchAgent.plistPath}`)
        break
      }

      case 'uninstall': {
        const launchAgent = uninstallSupervisorLaunchAgent()
        console.log('[ZeRo OS] Supervisor LaunchAgent removed.')
        console.log(`  Plist: ${launchAgent.plistPath}`)
        break
      }

      case 'status': {
        const launchAgent = getSupervisorLaunchAgentStatus()
        console.log('[ZeRo OS] Supervisor LaunchAgent status')
        console.log(`  Label:      ${'com.zero-os.supervisor'}`)
        console.log(`  Installed:  ${launchAgent.installed ? 'yes' : 'no'}`)
        console.log(`  Loaded:     ${launchAgent.loaded ? 'yes' : 'no'}`)
        console.log(`  Plist:      ${launchAgent.plistPath}`)
        if (launchAgent.details) {
          console.log(`  Details:    ${launchAgent.details.split('\n')[0]}`)
        }
        break
      }

      default:
        console.error('Usage: bun zero launchctl <install|uninstall|status>')
        process.exit(1)
    }
  } catch (err) {
    console.error('[ZeRo OS] launchctl command failed:', toErrorMessage(err))
    process.exit(1)
  }
}
