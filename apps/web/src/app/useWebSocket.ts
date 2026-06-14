import { useCallback, useEffect, useRef } from 'react'

interface UseWebSocketOptions {
  url: string
  topics: string[]
  onEvent?: (topic: string, data: unknown) => void
  onStream?: (sessionId: string, delta: string) => void
}

interface SocketSubscriber {
  onEventRef: { current: UseWebSocketOptions['onEvent'] }
  onStreamRef: { current: UseWebSocketOptions['onStream'] }
}

interface SharedSocket {
  key: string
  url: string
  topics: string[]
  ws: WebSocket | null
  reconnectTimer: ReturnType<typeof setTimeout> | null
  subscribers: Set<SocketSubscriber>
}

const sharedSockets = new Map<string, SharedSocket>()

export function useWebSocket({ url, topics, onEvent, onStream }: UseWebSocketOptions) {
  const onEventRef = useRef(onEvent)
  const onStreamRef = useRef(onStream)
  const socketRef = useRef<SharedSocket | null>(null)
  const subscriberRef = useRef<SocketSubscriber>({
    onEventRef,
    onStreamRef,
  })
  const topicsKey = JSON.stringify(topics)
  const socketKey = `${url}::${topicsKey}`

  useEffect(() => {
    onEventRef.current = onEvent
  }, [onEvent])

  useEffect(() => {
    onStreamRef.current = onStream
  }, [onStream])

  useEffect(() => {
    const socket = getSharedSocket(socketKey, url, JSON.parse(topicsKey) as string[])
    socket.subscribers.add(subscriberRef.current)
    socketRef.current = socket
    connectSharedSocket(socket)

    return () => {
      socket.subscribers.delete(subscriberRef.current)

      if (socket.subscribers.size > 0) return

      if (socket.reconnectTimer) {
        clearTimeout(socket.reconnectTimer)
        socket.reconnectTimer = null
      }

      if (socket.ws) {
        socket.ws.onopen = null
        socket.ws.onmessage = null
        socket.ws.onclose = null
        socket.ws.onerror = null
        socket.ws.close()
        socket.ws = null
      }

      sharedSockets.delete(socket.key)
    }
  }, [socketKey, topicsKey, url])

  const send = useCallback((data: unknown) => {
    const socket = socketRef.current?.ws
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data))
    }
  }, [])

  return { send }
}

function getSharedSocket(key: string, url: string, topics: string[]): SharedSocket {
  const existing = sharedSockets.get(key)
  if (existing) {
    return existing
  }

  const socket: SharedSocket = {
    key,
    url,
    topics,
    ws: null,
    reconnectTimer: null,
    subscribers: new Set(),
  }

  sharedSockets.set(key, socket)
  return socket
}

function connectSharedSocket(socket: SharedSocket) {
  if (socket.subscribers.size === 0) return
  if (socket.ws && socket.ws.readyState !== WebSocket.CLOSED) return

  if (socket.reconnectTimer) {
    clearTimeout(socket.reconnectTimer)
    socket.reconnectTimer = null
  }

  const ws = new WebSocket(socket.url)
  socket.ws = ws

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'subscribe', topics: socket.topics }))
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      for (const subscriber of socket.subscribers) {
        if (msg.type === 'event') {
          subscriber.onEventRef.current?.(msg.topic, msg.data)
        } else if (msg.type === 'stream') {
          subscriber.onStreamRef.current?.(msg.sessionId, msg.delta)
        }
      }
    } catch {}
  }

  ws.onclose = () => {
    if (socket.ws === ws) {
      socket.ws = null
    }

    if (socket.subscribers.size === 0) return

    socket.reconnectTimer = setTimeout(() => {
      connectSharedSocket(socket)
    }, 3000)
  }

  ws.onerror = () => {
    ws.close()
  }
}
