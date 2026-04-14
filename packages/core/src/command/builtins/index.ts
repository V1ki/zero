import type { CommandRouter } from '../router'
import { modelCommand } from './model'
import { newSessionCommand } from './new-session'
import { sessionCommand } from './session'
import { thinkCommand } from './think'

export { buildNewSessionReply, newSessionCommand } from './new-session'
export { modelCommand } from './model'
export { buildSessionInfoReply, parseSessionArgs, sessionCommand } from './session'
export { thinkCommand } from './think'

export function registerBuiltinCommands(router: CommandRouter): void {
  router.register(newSessionCommand)
  router.register(modelCommand)
  router.register(thinkCommand)
  router.register(sessionCommand)
}
