import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'

export type ListenerEnv = { Bindings: { remoteAddress?: string } }

export function badInput(message: string): never {
  throw new HTTPException(400, { message })
}

export function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    badInput('配置包含未知字段或对象格式无效。')
  }
  return value as Record<string, unknown>
}

export function fieldText(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    /\p{Cc}/u.test(value) ||
    (required && !value.trim())
  )
    badInput(`${label}无效。`)
  return value.trim()
}

export function checked(value: unknown): boolean {
  if (typeof value !== 'boolean') badInput('开关值无效。')
  return value
}

export function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    badInput('配置版本无效。')
  return value
}

export function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  return choices.find((option) => value === option) ?? badInput(`${label}无效。`)
}

export async function requestJson(c: Context<ListenerEnv>): Promise<unknown> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HTTPException(415, { message: '此操作需要 application/json。' })
  }
  try {
    return await c.req.json()
  } catch (err) {
    if (err instanceof SyntaxError) badInput('JSON 格式无效。')
    throw err
  }
}

export function pageNumber(raw: string | undefined, max: number): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > max)
    badInput('分页参数无效。')
  return value
}
