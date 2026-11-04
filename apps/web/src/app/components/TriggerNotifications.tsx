import { Bell, X } from '@phosphor-icons/react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { TriggerWebNotification } from '@zero-os/shared'
import { useEffect, useRef, useState } from 'react'
import {
  localWebNotifications,
  webNotificationHistoryKey,
  webNotificationsApi,
} from '../lib/web-notifications'
import './TriggerNotifications.css'

const presenceCooldown = 20_000
const cursorKey = 'zero-web-notifications-v2-cursor'
function storedCursor() {
  // Storage is optional in private windows and embedded browsers.
  try {
    const value = localStorage.getItem(cursorKey)
    if (value === null || !/^(0|[1-9]\d*)$/.test(value)) return undefined
    const id = Number(value)
    return Number.isSafeInteger(id) ? id : undefined
  } catch {
    return undefined
  }
}
function persistCursor(id: number) {
  try {
    localStorage.setItem(cursorKey, String(id))
  } catch {
    // The mounted tab still tracks its cursor if browser storage is disabled.
  }
}
type Notice = { kind: 'task'; taskId: number } | { kind: 'legacy' | 'multiple' }

function isActiveWindow() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

async function readNoticeData<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  if (!response.ok) throw new Error('读取网页提醒状态失败')
  return response.json() as Promise<T>
}

export function TriggerNotifications() {
  const cache = useQueryClient()
  const [active, setActive] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const cursor = useRef<number | undefined>(undefined)
  const otherTabs = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    if (!localWebNotifications()) return
    const controller = new AbortController()
    let lastPresenceAt = Number.NEGATIVE_INFINITY
    let presenceFailed = false
    cursor.current = storedCursor()

    function syncCursor(event: StorageEvent) {
      if (event.key !== cursorKey && event.key !== null) return
      const saved = storedCursor()
      if (saved === undefined || (cursor.current !== undefined && saved < cursor.current))
        setNotice(null)
      cursor.current = saved
      void cache.invalidateQueries({ queryKey: webNotificationHistoryKey })
    }

    function refreshActive() {
      setActive(isActiveWindow())
    }
    function recordActivity(event: Event) {
      if (!event.isTrusted || !isActiveWindow() || Date.now() - lastPresenceAt < presenceCooldown)
        return
      lastPresenceAt = Date.now()
      void fetch('/api/listeners/routing/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error('Web presence request failed')
          presenceFailed = false
        })
        .catch(() => {
          if (!controller.signal.aborted && !presenceFailed) {
            console.warn('[Listeners] Web presence unavailable; will retry on later activity.')
            presenceFailed = true
          }
        })
    }

    refreshActive()
    window.addEventListener('storage', syncCursor)
    window.addEventListener('focus', refreshActive)
    window.addEventListener('blur', refreshActive)
    document.addEventListener('visibilitychange', refreshActive)
    for (const type of ['focus', 'pointerdown', 'pointermove', 'keydown', 'wheel']) {
      window.addEventListener(type, recordActivity, { passive: true, signal: controller.signal })
    }

    if (typeof BroadcastChannel !== 'undefined') {
      // Legacy and unified records allocate sequences independently.
      const channel = new BroadcastChannel('zero-web-notifications-v2')
      otherTabs.current = channel
      channel.onmessage = ({ data }) => {
        if (Number.isSafeInteger(data) && data > (cursor.current ?? 0)) {
          cursor.current = data
          void cache.invalidateQueries({ queryKey: webNotificationHistoryKey })
        }
      }
    }
    return () => {
      controller.abort()
      window.removeEventListener('storage', syncCursor)
      window.removeEventListener('focus', refreshActive)
      window.removeEventListener('blur', refreshActive)
      document.removeEventListener('visibilitychange', refreshActive)
      otherTabs.current?.close()
      otherTabs.current = null
    }
  }, [cache])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    const { signal } = controller
    let busy = false
    let failed = false
    let checkAgain = false
    async function check() {
      if (signal.aborted || !isActiveWindow()) return
      if (busy) {
        checkAgain = true
        return
      }
      busy = true
      const previous = cursor.current
      try {
        const { id } = await readNoticeData<{ id: number }>(`${webNotificationsApi}/latest`, signal)
        if (signal.aborted || !Number.isSafeInteger(id) || id < 0) return
        if (cursor.current !== previous) {
          checkAgain = true
          return
        }
        // The first successful foreground read establishes a baseline without replaying history.
        if (previous === undefined || id <= previous) {
          // A replaced or emptied local database can restart its sequence.
          if (previous !== undefined && id < previous) setNotice(null)
          if (cursor.current !== id) {
            cursor.current = id
            persistCursor(id)
          }
          failed = false
          return
        }
        // Two metadata-only rows distinguish a single direct link from a batch; older rows stay in history.
        const page = await readNoticeData<{
          items: Array<Pick<TriggerWebNotification, 'id' | 'taskId'>>
          latestId: number
        }>(`${webNotificationsApi}?after=${previous}&limit=2&brief=1`, signal)
        if (signal.aborted || cursor.current !== previous || !isActiveWindow()) return
        if (!Number.isSafeInteger(page.latestId) || page.latestId < previous) return
        const fresh = page.items.filter(
          (item) => Number.isSafeInteger(item.id) && item.id > previous && item.id <= page.latestId,
        )
        const saved = storedCursor()
        if (saved !== undefined && saved > previous && saved <= page.latestId) {
          cursor.current = saved
          checkAgain = true
          return
        }
        cursor.current = page.latestId
        persistCursor(page.latestId)
        failed = false
        if (!fresh.length) return
        const first = fresh[0]
        const next: Notice =
          fresh.length > 1
            ? { kind: 'multiple' }
            : first.taskId
              ? { kind: 'task', taskId: first.taskId }
              : { kind: 'legacy' }
        setNotice((pending) => (pending ? { kind: 'multiple' } : next))
        otherTabs.current?.postMessage(page.latestId)
        void cache.invalidateQueries({ queryKey: webNotificationHistoryKey })
      } catch {
        if (!signal.aborted && !failed) {
          console.warn('[Listeners] Web reminders unavailable; will retry.')
          failed = true
        }
      } finally {
        busy = false
        if (checkAgain) {
          checkAgain = false
          void check()
        }
      }
    }
    void check()
    const stream =
      typeof EventSource === 'undefined' ? null : new EventSource(`${webNotificationsApi}/changes`)
    if (stream)
      stream.onmessage = (message) => {
        if (message.data === 'changed') void check()
      }
    const timer = window.setInterval(() => void check(), 30_000)
    window.addEventListener('online', check)
    return () => {
      controller.abort()
      stream?.close()
      window.clearInterval(timer)
      window.removeEventListener('online', check)
    }
  }, [active, cache])

  if (!notice) return null
  return (
    <aside className="trigger-web-notice" aria-label="网页提醒">
      <Bell size={19} aria-hidden="true" />
      <output>{notice.kind === 'multiple' ? '有多条新的网页提醒' : '有新的网页提醒'}</output>
      {notice.kind === 'task' ? (
        <Link to="/router" search={{ task: notice.taskId }} onClick={() => setNotice(null)}>
          打开任务 #{notice.taskId}
        </Link>
      ) : notice.kind === 'legacy' ? (
        <a href="/config?tab=listeners#routing-web">查看网页通知</a>
      ) : (
        <Link to="/router" search={{ view: 'notifications' }} onClick={() => setNotice(null)}>
          查看全部网页提醒
        </Link>
      )}
      <button type="button" aria-label="关闭网页提醒" onClick={() => setNotice(null)}>
        <X size={16} />
      </button>
    </aside>
  )
}
