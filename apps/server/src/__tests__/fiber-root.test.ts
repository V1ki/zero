import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber } from 'effect'
import { createFiberRootRuntime } from '../runtime/fiber-root'

describe('createFiberRootRuntime', () => {
  test('shutdown interrupts fibers still alive under the root scope', async () => {
    const root = createFiberRootRuntime()
    const fiber = root.fork(Effect.sleep(60_000))

    await root.shutdown()
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterrupted(exit.cause)).toBe(true)
    }
  })

  test('shutdown tolerates fibers that already completed', async () => {
    const root = createFiberRootRuntime()
    const fiber = root.fork(Effect.succeed(42))

    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isSuccess(exit)).toBe(true)

    await root.shutdown()
  })

  test('shutdown runs acquireRelease finalizers of member fibers', async () => {
    const root = createFiberRootRuntime()
    let released = false
    const program = Effect.acquireRelease(Effect.succeed(1), () =>
      Effect.sync(() => {
        released = true
      }),
    ).pipe(
      Effect.flatMap(() => Effect.never),
      Effect.scoped,
    )

    root.fork(program)
    await root.shutdown()

    expect(released).toBe(true)
  })

  test('forking after shutdown yields an interrupted fiber instead of leaking it', async () => {
    const root = createFiberRootRuntime()
    await root.shutdown()

    const fiber = root.fork(Effect.sleep(60_000))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isInterrupted(exit.cause)).toBe(true)
    }
  })
})
