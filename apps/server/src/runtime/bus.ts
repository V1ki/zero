import { EventEmitter } from 'node:events'

export type BusEvent =
  | 'session:create'
  | 'session:update'
  | 'session:end'
  | 'tool:call'
  | 'tool:result'
  | 'background_tool:started'
  | 'background_tool:progress'
  | 'background_tool:completed'
  | 'model:switch'
  | 'notification'
  | 'metrics:cost'
  | 'heartbeat'
  | 'config:update'
  | 'repair:start'
  | 'repair:end'
  | 'fuse:trigger'

export interface BusPayload {
  topic: BusEvent
  data: Record<string, unknown>
  timestamp: string
}

/**
 * Global event bus for ZeRo OS.
 * All internal events flow through this bus for real-time UI updates and logging.
 */
export class EventBus {
  private emitter: EventEmitter

  constructor() {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(100)
  }

  emit(topic: BusEvent, data: Record<string, unknown>): void {
    const payload: BusPayload = {
      topic,
      data,
      timestamp: new Date().toISOString(),
    }
    this.emitter.emit(topic, payload)
    this.emitter.emit('*', payload) // wildcard
  }

  on(topic: BusEvent | '*', handler: (payload: BusPayload) => void): void {
    this.emitter.on(topic, handler)
  }

  off(topic: BusEvent | '*', handler: (payload: BusPayload) => void): void {
    this.emitter.off(topic, handler)
  }

  once(topic: BusEvent, handler: (payload: BusPayload) => void): void {
    this.emitter.once(topic, handler)
  }
}

/**
 * Singleton global bus instance.
 */
export const globalBus = new EventBus()
