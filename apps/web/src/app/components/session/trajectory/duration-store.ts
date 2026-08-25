/**
 * Trajectory duration preference, persisted in localStorage. Replaces the DSH
 * runtime snapshot store with a minimal observable of the same shape.
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from './types'

const STORAGE_KEY = 'zero.trajectory.duration'

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Create the app-wide trajectory duration preference source.
 * @returns a persisted boolean store shared across views.
 */
export function createTrajectoryDurationStore(): SnapshotStore<boolean> {
  const listeners = new Set<(value: boolean) => void>()
  let value = readStored()
  return {
    get: () => value,
    set: (next: boolean) => {
      value = next
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // Storage can be unavailable in private modes; the in-memory value stands.
      }
      for (const listener of listeners) listener(value)
    },
    subscribe: (listener: (next: boolean) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Subscribe to a snapshot store from a React component.
 * @param store - the observable value source.
 * @returns the current value, re-rendered on change.
 */
export function useSnapshotStoreValue(store: SnapshotStore<boolean>): boolean {
  const [value, setValue] = useState(store.get)
  useEffect(() => store.subscribe(setValue), [store])
  return value
}
