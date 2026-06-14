import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { installConsoleTimestamping } from '@zero-os/shared'
import { startZeroOS } from '../main'

interface RunStartCommandOptions {
  zeroDir: string
}

export async function runStartCommand({ zeroDir }: RunStartCommandOptions): Promise<void> {
  installConsoleTimestamping()

  if (!existsSync(join(zeroDir, 'config.yaml'))) {
    console.error('[ZeRo OS] Error: .zero/config.yaml not found. Run `bun zero init` first.')
    process.exit(1)
  }

  const zero = await startZeroOS({
    onCoreReady: async (runtime) => {
      const { startWebServer } = await import('../../../web/src/server')
      const web = startWebServer(runtime)
      console.log(`[ZeRo OS] Web UI: http://localhost:${web.port}`)
    },
  })

  process.on('SIGINT', () => zero.shutdown())
  process.on('SIGTERM', () => zero.shutdown())
}
