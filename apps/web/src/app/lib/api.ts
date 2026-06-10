import { hc } from 'hono/client'
import type { AppType } from '../../api/routes'
import { useUIStore } from '../stores/ui'

export const client = hc<AppType>('/')

const API_BASE = ''

function showErrorToast(message: string) {
  useUIStore.getState().addToast('error', message)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init)
  if (!res.ok) {
    const detail = await readErrorDetail(res)
    const message = detail
      ? `请求失败: ${res.status} ${detail}`
      : `请求失败: ${res.status} ${res.statusText}`
    showErrorToast(message)
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

async function readErrorDetail(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''

  if (contentType.includes('application/json')) {
    const payload = (await res.json().catch(() => null)) as {
      error?: unknown
      message?: unknown
    } | null
    if (typeof payload?.error === 'string' && payload.error.trim().length > 0) {
      return payload.error.trim()
    }
    if (typeof payload?.message === 'string' && payload.message.trim().length > 0) {
      return payload.message.trim()
    }
    return ''
  }

  const text = await res.text().catch(() => '')
  return text.trim()
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export async function apiDelete<T>(path: string): Promise<T> {
  return apiFetch<T>(path, { method: 'DELETE' })
}

export { useUIStore } from '../stores/ui'
