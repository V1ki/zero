import { describe, expect, test } from 'bun:test'
import { LOGS_USAGE, LogsUsageError, resolveLogsRequest } from '../cli/logs'

describe('resolveLogsRequest', () => {
  test('defaults to all supervisor logs and 100 lines', () => {
    expect(resolveLogsRequest({ zeroDir: '/tmp/zero', args: [] })).toEqual({
      follow: false,
      lines: 100,
      logFiles: ['/tmp/zero/logs/supervisor.log', '/tmp/zero/logs/supervisor.error.log'],
    })
  })

  test('resolves target aliases, line count, and follow flag', () => {
    expect(resolveLogsRequest({ zeroDir: '/tmp/zero', args: ['err', '-n', '25', '-f'] })).toEqual({
      follow: true,
      lines: 25,
      logFiles: ['/tmp/zero/logs/supervisor.error.log'],
    })
  })

  test('rejects invalid usage without exiting', () => {
    expect(() => resolveLogsRequest({ zeroDir: '/tmp/zero', args: ['missing'] })).toThrow(
      LogsUsageError,
    )
    expect(() => resolveLogsRequest({ zeroDir: '/tmp/zero', args: ['--lines', '0'] })).toThrow(
      LOGS_USAGE,
    )
  })
})
