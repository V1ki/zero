import type { Effect, Fiber } from 'effect'

/**
 * Forks a long-lived Effect into a host-owned lifetime — at the composition
 * root this is the unified fiber root scope, so closing the host interrupts
 * every forked fiber at once. Modules accept this as an optional seam and
 * default to a plain Effect.runFork, keeping standalone/test usage unchanged.
 */
export type ForkEffect = <A, E>(effect: Effect.Effect<A, E>) => Fiber.RuntimeFiber<A, E>
