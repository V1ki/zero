import type { ForkEffect } from '@zero-os/shared'
import { Effect, Exit, FiberId, Scope } from 'effect'
import type { Fiber } from 'effect'

/**
 * The composition root's unified fiber lifetime. Long-lived module fibers
 * (scheduler waits, heartbeat, memory flush debounce, pricing/catalog
 * refresh) fork through `fork` so they live under one root scope; modules
 * keep their own stop()/dispose() for ordered shutdown, and `shutdown()` is
 * the umbrella that interrupts anything still alive afterwards — one
 * interruption reaps every survivor. Forking after `shutdown()` returns an
 * already-interrupted fiber instead of parking a zombie outside the scope.
 */
export interface FiberRootRuntime {
  /** Fork a long-lived effect under the root scope. */
  fork: ForkEffect
  /** Interrupt every fiber still alive under the root scope. */
  shutdown(): Promise<void>
}

export function createFiberRootRuntime(): FiberRootRuntime {
  const scope = Effect.runSync(Scope.make())
  let closed = false
  return {
    fork<A, E>(effect: Effect.Effect<A, E>): Fiber.RuntimeFiber<A, E> {
      if (closed) return Effect.runFork(Effect.interrupt)
      return Effect.runFork(effect, { scope })
    },
    async shutdown() {
      closed = true
      await Effect.runPromise(Scope.close(scope, Exit.interrupt(FiberId.none)))
    },
  }
}
