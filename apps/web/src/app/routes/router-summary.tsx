import { useQuery } from '@tanstack/react-query'
import { type RouterSummary, type RouterSummaryWindow, routerSummaryWindows } from '@zero-os/shared'
import { useState } from 'react'
import { apiFetch } from '../lib/api'
import { summaryCoverage, summaryGroups } from './router-summary-text'
import './router-summary.css'

/** Counts of recent Router activity, read on request. Nothing here carries event content. */
export function RouterSummaryView() {
  const [days, setDays] = useState<RouterSummaryWindow>(7)
  const summary = useQuery({
    queryKey: ['router-summary', days],
    queryFn: ({ signal }) =>
      apiFetch<RouterSummary>(`/api/listeners/workspace-summary?days=${days}`, {
        signal,
        cache: 'no-store',
      }),
    retry: false,
  })
  const data = summary.data
  return (
    <section className="rs-summary" aria-labelledby="rs-title">
      <header>
        <div>
          <h2 id="rs-title">Router 效果统计</h2>
          <p>看看分诊有没有挡掉你想看的事，汇报有没有问对问题。</p>
        </div>
        <fieldset className="rs-window">
          <legend>统计范围</legend>
          {routerSummaryWindows.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={days === value}
              onClick={() => setDays(value)}
            >
              近 {value} 天
            </button>
          ))}
        </fieldset>
      </header>
      {summary.isLoading && <p>正在统计…</p>}
      {summary.error && (
        <p role="alert" className="rw-error">
          {summary.error.message}
        </p>
      )}
      {data && (
        <>
          {summaryGroups(data).map((group) => (
            <section key={group.id} className="rs-group" aria-labelledby={`rs-${group.id}`}>
              <h3 id={`rs-${group.id}`}>{group.heading}</h3>
              <p className="rs-sentence">{group.sentence}</p>
              {group.warnings.map((warning) => (
                <p key={warning} className="rs-warning">
                  <strong>值得看一眼：</strong>
                  {warning}
                </p>
              ))}
              <dl>
                {group.figures.map((figure) => (
                  <div key={figure.label}>
                    <dt>{figure.label}</dt>
                    <dd>
                      <strong>{figure.value}</strong>
                      <span>之前 {figure.previous}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              {group.notes.map((note) => (
                <p key={note} className="rs-note">
                  {note}
                </p>
              ))}
            </section>
          ))}
          <section className="rs-coverage" aria-labelledby="rs-coverage">
            <h3 id="rs-coverage">这些数字怎么算</h3>
            {summaryCoverage(data).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </section>
        </>
      )}
    </section>
  )
}
