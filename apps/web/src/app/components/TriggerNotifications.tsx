import { Bell, X } from '@phosphor-icons/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import './TriggerNotifications.css'

const base = '/api/listeners/routing'
const presenceCooldown = 20_000
const webNoticesHref = '/config?tab=listeners#routing-web'

function isActiveWindow() {
  return document.visibilityState === 'visible' && document.hasFocus()
}

export function TriggerNotifications() {
  const [active, setActive] = useState(false)
  const [notice, setNotice] = useState(false)
  const lastDelivery = useRef<number | undefined>(undefined)
  const otherTabs = useRef<BroadcastChannel | null>(null)

  useEffect(() => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return
    const controller = new AbortController()
    let lastPresenceAt = Number.NEGATIVE_INFINITY
    let presenceFailed = false

    function refreshActive() {
      setActive(isActiveWindow())
    }
    function recordActivity(event: Event) {
      if (!event.isTrusted || !isActiveWindow() || Date.now() - lastPresenceAt < presenceCooldown)
        return
      lastPresenceAt = Date.now()
      void fetch(`${base}/presence`, {
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
    window.addEventListener('focus', refreshActive)
    window.addEventListener('blur', refreshActive)
    document.addEventListener('visibilitychange', refreshActive)
    for (const type of ['focus', 'pointerdown', 'pointermove', 'keydown', 'wheel']) {
      window.addEventListener(type, recordActivity, { passive: true, signal: controller.signal })
    }

    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('zero-web-routing-delivery')
      otherTabs.current = channel
      channel.onmessage = ({ data }) => {
        if (Number.isSafeInteger(data) && data > (lastDelivery.current ?? 0))
          lastDelivery.current = data
      }
    }
    return () => {
      controller.abort()
      window.removeEventListener('focus', refreshActive)
      window.removeEventListener('blur', refreshActive)
      document.removeEventListener('visibilitychange', refreshActive)
      otherTabs.current?.close()
      otherTabs.current = null
    }
  }, [])

  // The global UI needs only a delivery sequence. Task content stays on the records page.
  const { data } = useQuery({
    queryKey: ['listeners', 'web-delivery-marker'],
    enabled: active,
    queryFn: async ({ signal }) => {
      const response = await fetch(`${base}/web/latest`, { signal, cache: 'no-store' })
      if (!response.ok) throw new Error('读取网页提醒状态失败')
      return (await response.json()) as { latestId: number | null }
    },
    retry: false,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  })

  useEffect(() => {
    if (!active || !data) return
    const marker = data.latestId ?? 0
    if (!Number.isSafeInteger(marker) || marker < 0) return
    const previous = lastDelivery.current
    lastDelivery.current = Math.max(previous ?? 0, marker)
    if (previous !== undefined && marker > previous) {
      setNotice(true)
      otherTabs.current?.postMessage(marker)
    }
  }, [active, data])

  if (!notice) return null
  return (
    <aside className="trigger-web-notice" aria-label="网页提醒">
      <Bell size={19} aria-hidden="true" />
      <output>有新的网页提醒</output>
      <a href={webNoticesHref} onClick={() => setNotice(false)}>
        查看网页通知
      </a>
      <button type="button" aria-label="关闭网页提醒" onClick={() => setNotice(false)}>
        <X size={16} />
      </button>
    </aside>
  )
}
