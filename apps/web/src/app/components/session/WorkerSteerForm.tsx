import { type FormEvent, useRef, useState } from 'react'
import { apiPost } from '../../lib/api'

export function isCodexWorkerRun(name: string | undefined, input: unknown): boolean {
  if (name !== 'worker') return false
  let args = input
  if (typeof input === 'string') {
    try {
      args = JSON.parse(input)
    } catch {
      return false
    }
  }
  return (
    typeof args === 'object' &&
    args !== null &&
    'type' in args &&
    args.type === 'codex' &&
    (!('action' in args) || args.action === 'run')
  )
}

export function WorkerSteerForm({
  sessionId,
  toolUseId,
}: { sessionId: string; toolUseId: string }) {
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const inFlight = useRef(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = instruction.trim()
    if (!text || inFlight.current) return
    inFlight.current = true
    setPending(true)
    setFeedback('')
    try {
      await apiPost(
        `/api/sessions/${encodeURIComponent(sessionId)}/tool-calls/${encodeURIComponent(toolUseId)}/steer`,
        { instruction: text },
      )
      setInstruction('')
      setFeedback('Instruction accepted by Worker')
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not send the instruction')
    } finally {
      inFlight.current = false
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 p-3">
      <label className="block text-xs text-[var(--color-text-muted)]">
        Worker instruction
        <textarea
          value={instruction}
          onChange={(event) => {
            setInstruction(event.target.value)
            setFeedback('')
          }}
          disabled={pending}
          placeholder="Adjust this running task…"
          rows={2}
          className="mt-1 block w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-[var(--color-text-primary)]"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending || !instruction.trim()}
          className="rounded-lg border border-cyan-400/25 px-3 py-1.5 text-xs text-cyan-200 disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Send instruction'}
        </button>
        <output className="text-xs text-[var(--color-text-muted)]">{feedback}</output>
      </div>
    </form>
  )
}
