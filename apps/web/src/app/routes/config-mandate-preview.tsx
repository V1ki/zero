import { useMutation } from '@tanstack/react-query'
import type { MandateArchive, MandateDestination, MandateTarget } from '@zero-os/shared'
import { useState } from 'react'
import { apiPost } from '../lib/api'
import { mandateDestinations } from './mandate-policy-fields'

export function localInputDate(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

interface Preview {
  decision: {
    destination: MandateDestination
    reason: string
    recheckAt?: string
    target?: MandateTarget
    digestKey?: string
  }
  archive: MandateArchive | null
}

export function MandatePreview({ mandateId }: { mandateId: string }) {
  const [instant, setInstant] = useState(() => localInputDate(new Date()))
  const [presence, setPresence] = useState('present')
  const [urgency, setUrgency] = useState('saved')
  const run = useMutation({
    mutationFn: (at: string) =>
      apiPost<Preview>('/api/listeners/mandates/preview', {
        mandateId,
        at,
        present: presence === 'unknown' ? null : presence === 'present',
        ...(urgency === 'saved' ? {} : { urgent: urgency === 'urgent' }),
      }),
  })
  return (
    <details className="listener-item">
      <summary>预演这条委托</summary>
      <p className="listener-muted">使用已保存的项目和委托偏好试算。预演只返回决定及原因。</p>
      <div className="listener-fields">
        <label className="listener-field">
          预演时间（{Intl.DateTimeFormat().resolvedOptions().timeZone}）
          <input
            type="datetime-local"
            value={instant}
            disabled={run.isPending}
            onChange={(e) => {
              setInstant(e.target.value)
              run.reset()
            }}
          />
        </label>
        <label className="listener-field">
          预演在场状态
          <select
            value={presence}
            disabled={run.isPending}
            onChange={(e) => {
              setPresence(e.target.value)
              run.reset()
            }}
          >
            <option value="present">在电脑前</option>
            <option value="away">已离开</option>
            <option value="unknown">未知</option>
          </select>
        </label>
        <label className="listener-field">
          预演紧急程度
          <select
            value={urgency}
            disabled={run.isPending}
            onChange={(e) => {
              setUrgency(e.target.value)
              run.reset()
            }}
          >
            <option value="saved">沿用委托</option>
            <option value="normal">普通</option>
            <option value="urgent">紧急</option>
          </select>
        </label>
      </div>
      <div className="listener-row">
        <button
          type="button"
          disabled={run.isPending || !Number.isFinite(new Date(instant).getTime())}
          onClick={() => run.mutate(new Date(instant).toISOString())}
        >
          运行委托预演
        </button>
        {run.isPending && <small>正在预演…</small>}
      </div>
      {run.error && (
        <p role="alert" className="listener-error">
          {run.error.message}
        </p>
      )}
      {run.data && (
        <output className="mandate-preview" aria-live="polite">
          <strong>{mandateDestinations[run.data.decision.destination]}</strong>
          <span>
            <small>判断依据 · </small>
            {run.data.decision.reason}
          </span>
          {run.data.decision.target && (
            <small>
              提醒目标 · {run.data.decision.target.channelId} / {run.data.decision.target.peerId}
            </small>
          )}
          {run.data.decision.recheckAt && (
            <small>下次复核 · {new Date(run.data.decision.recheckAt).toLocaleString()}</small>
          )}
          {run.data.decision.digestKey && <small>将纳入本期摘要</small>}
          <small>
            {run.data.archive
              ? `另行归档 · ${run.data.archive.channelId} / ${run.data.archive.documentId}`
              : '无归档目标'}
          </small>
        </output>
      )}
    </details>
  )
}
