import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BashTool } from '../bash'
import { EditTool } from '../edit'
import { ReadTool } from '../read'
import { ReadImageTool } from '../read-image'
import { ToolRegistry } from '../registry'
import { WriteTool } from '../write'
import { SessionRunningToolRegistry } from '../../session/running-tool-registry'

const testDir = join(import.meta.dir, '__fixtures__')
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
const ctx = {
  sessionId: 'test_session',
  workDir: process.cwd(),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}

describe('ReadTool', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('reads a file successfully', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'read-test.txt')
    writeFileSync(filePath, 'line1\nline2\nline3\n', 'utf-8')

    const tool = new ReadTool()
    const result = await tool.run(ctx, { path: filePath })
    expect(result.success).toBe(true)
    expect(result.output).toContain('line1')
    expect(result.output).toContain('line3')
  })

  test('reads with offset and limit', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'read-offset.txt')
    writeFileSync(filePath, 'a\nb\nc\nd\ne\n', 'utf-8')

    const tool = new ReadTool()
    const result = await tool.run(ctx, { path: filePath, offset: 1, limit: 2 })
    expect(result.success).toBe(true)
    expect(result.output).toBe('b\nc')
  })

  test('returns error for missing file', async () => {
    const tool = new ReadTool()
    const result = await tool.run(ctx, { path: '/nonexistent/file.txt' })
    expect(result.success).toBe(false)
    expect(result.output).toContain('File not found')
  })
})

describe('ReadImageTool', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('reads a local PNG as structured image content', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'read-image.png')
    writeFileSync(filePath, Buffer.from(tinyPngBase64, 'base64'))

    const tool = new ReadImageTool()
    const result = await tool.run(ctx, { path: filePath })

    expect(result.success).toBe(true)
    expect(result.output).toContain(filePath)
    expect(result.output).not.toContain(tinyPngBase64)
    expect(result.outputSummary).not.toContain(tinyPngBase64)
    expect(result.contentItems).toEqual([
      { type: 'image', mediaType: 'image/png', data: tinyPngBase64 },
    ])
    expect(result.artifacts).toContain(filePath)
  })

  test('rejects remote URLs', async () => {
    const tool = new ReadImageTool()
    const result = await tool.run(ctx, { path: 'https://example.com/image.png' })

    expect(result.success).toBe(false)
    expect(result.output).toContain('local filesystem paths')
  })

  test('rejects unsupported file content', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'not-an-image.txt')
    writeFileSync(filePath, 'plain text', 'utf-8')

    const tool = new ReadImageTool()
    const result = await tool.run(ctx, { path: filePath })

    expect(result.success).toBe(false)
    expect(result.output).toContain('Unsupported')
  })

  test('rejects oversized images before attaching content', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'oversized.png')
    const oversizedPng = Buffer.alloc(10 * 1024 * 1024 + 1)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPng)
    writeFileSync(filePath, oversizedPng)

    const tool = new ReadImageTool()
    const result = await tool.run(ctx, { path: filePath })

    expect(result.success).toBe(false)
    expect(result.output).toContain('too large')
    expect(result.contentItems).toBeUndefined()
  })
})

describe('WriteTool', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('writes a new file', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'write-test.txt')

    const tool = new WriteTool()
    const result = await tool.run(ctx, { path: filePath, content: 'hello world' })
    expect(result.success).toBe(true)
    expect(result.artifacts).toContain(filePath)

    const readTool = new ReadTool()
    const readResult = await readTool.run(ctx, { path: filePath })
    expect(readResult.output).toBe('hello world')
  })

  test('creates directories if needed', async () => {
    const filePath = join(testDir, 'deep/nested/dir/file.txt')
    const tool = new WriteTool()
    const result = await tool.run(ctx, { path: filePath, content: 'nested!' })
    expect(result.success).toBe(true)
  })
})

describe('EditTool', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('replaces text in a file', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'edit-test.txt')
    writeFileSync(filePath, 'hello world', 'utf-8')

    const tool = new EditTool()
    const result = await tool.run(ctx, { path: filePath, oldText: 'world', newText: 'ZeRo' })
    expect(result.success).toBe(true)

    const readTool = new ReadTool()
    const readResult = await readTool.run(ctx, { path: filePath })
    expect(readResult.output).toBe('hello ZeRo')
  })

  test('returns error when text not found', async () => {
    mkdirSync(testDir, { recursive: true })
    const filePath = join(testDir, 'edit-not-found.txt')
    writeFileSync(filePath, 'hello', 'utf-8')

    const tool = new EditTool()
    const result = await tool.run(ctx, { path: filePath, oldText: 'xyz', newText: 'abc' })
    expect(result.success).toBe(false)
    expect(result.output).toContain('Text not found')
  })
})

describe('BashTool', () => {
  test('executes shell commands', async () => {
    const tool = new BashTool([])
    const result = await tool.run(ctx, { command: 'echo "hello from bash"' })
    expect(result.success).toBe(true)
    expect(result.output).toContain('hello from bash')
  })

  test('injects session and channel env vars into subprocesses', async () => {
    const tool = new BashTool([])
    const result = await tool.run(
      {
        ...ctx,
        projectRoot: '/tmp/project-root',
        channelBinding: {
          source: 'telegram',
          channelName: 'telegram:ops',
          channelId: 'chat-42',
        },
      },
      {
        command:
          'printf "%s|%s|%s|%s|%s" "$ZERO_WORKSPACE" "$ZERO_PROJECT_ROOT" "$ZERO_SESSION_ID" "$ZERO_CHANNEL_NAME" "$ZERO_CHANNEL_ID"',
      },
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain(
      `${ctx.workDir}|/tmp/project-root|test_session|telegram:ops|chat-42`,
    )
  })

  test('returns exit code on failure', async () => {
    const tool = new BashTool([])
    const result = await tool.run(ctx, { command: 'exit 1' })
    expect(result.success).toBe(false)
  })

  test('blocks fuse-listed commands', async () => {
    const tool = new BashTool([{ pattern: 'rm -rf /', description: 'Recursive delete of root' }])
    const result = await tool.run(ctx, { command: 'rm -rf /' })
    expect(result.success).toBe(false)
    expect(result.output).toContain('fuse list')
  })

  test('allows non-fuse-listed commands', async () => {
    const tool = new BashTool([{ pattern: 'rm -rf /', description: 'Block root delete' }])
    const result = await tool.run(ctx, { command: 'echo safe' })
    expect(result.success).toBe(true)
  })

  test('does NOT block rm -rf /tmp when fuse blocks rm -rf /', async () => {
    const tool = new BashTool([{ pattern: 'rm -rf /', description: 'Block root delete' }])
    const result = await tool.run(ctx, { command: 'ls /tmp' })
    expect(result.success).toBe(true)
  })

  test('preserves partial output and appends an abort footer when aborted', async () => {
    const tool = new BashTool([])
    const runningToolRegistry = new SessionRunningToolRegistry()
    const toolUseId = 'call_bash_abort_1'
    const handle = runningToolRegistry.register({
      toolUseId,
      toolName: 'bash',
      abortable: true,
    })

    const runPromise = tool.run(
      {
        ...ctx,
        currentToolUseId: toolUseId,
        runningToolRegistry,
      },
      {
        command: 'echo start && sleep 5 && echo end',
        timeout: 10_000,
      },
    )

    await Bun.sleep(150)
    expect(handle.requestAbort('Command aborted by user from Session Detail.')).toBe('accepted')

    const result = await runPromise
    expect(result.success).toBe(false)
    expect(result.output).toContain('start')
    expect(result.output).not.toContain('end')
    expect(result.output).toContain('[abort]')
    expect(result.output).toContain('Command aborted by user from Session Detail.')
    expect(result.outputSummary).toContain('Command aborted:')
    expect(handle.getState()).toBe('finished')
    expect(handle.getTerminalMetadata()?.cause).toBe('abort')
  })

  test('double abort stays idempotent and does not duplicate the footer', async () => {
    const tool = new BashTool([])
    const runningToolRegistry = new SessionRunningToolRegistry()
    const toolUseId = 'call_bash_abort_2'
    const handle = runningToolRegistry.register({
      toolUseId,
      toolName: 'bash',
      abortable: true,
    })

    const runPromise = tool.run(
      {
        ...ctx,
        currentToolUseId: toolUseId,
        runningToolRegistry,
      },
      {
        command: 'echo start && sleep 5 && echo end',
        timeout: 10_000,
      },
    )

    await Bun.sleep(150)
    expect(handle.requestAbort('Command aborted by user from Session Detail.')).toBe('accepted')
    expect(handle.requestAbort('Command aborted by user from Session Detail.')).toBe(
      'already_requested',
    )

    const result = await runPromise
    expect(result.output.match(/\[abort\]/g)?.length).toBe(1)
    expect(handle.requestAbort('Command aborted by user from Session Detail.')).toBe(
      'already_finished',
    )
  })

  test('timeout wins over a later abort request', async () => {
    const tool = new BashTool([])
    const runningToolRegistry = new SessionRunningToolRegistry()
    const toolUseId = 'call_bash_timeout_abort'
    const handle = runningToolRegistry.register({
      toolUseId,
      toolName: 'bash',
      abortable: true,
    })

    const runPromise = tool.run(
      {
        ...ctx,
        currentToolUseId: toolUseId,
        runningToolRegistry,
      },
      {
        command: 'echo start && sleep 1 && echo end',
        timeout: 40,
      },
    )

    await Bun.sleep(80)
    expect(handle.requestAbort('Command aborted by user from Session Detail.')).toBe(
      'already_finished',
    )

    const result = await runPromise
    expect(result.success).toBe(false)
    expect(result.output).toContain('start')
    expect(result.output).not.toContain('[abort]')
    expect(handle.getTerminalMetadata()?.cause).toBe('timeout')
  })
})

describe('ToolRegistry', () => {
  test('register and retrieve tools', () => {
    const registry = new ToolRegistry()
    registry.register(new ReadTool())
    registry.register(new WriteTool())

    expect(registry.has('read')).toBe(true)
    expect(registry.has('write')).toBe(true)
    expect(registry.has('nonexistent')).toBe(false)
    expect(registry.list()).toHaveLength(2)
  })

  test('getDefinitions returns tool schemas', () => {
    const registry = new ToolRegistry()
    registry.register(new ReadTool())

    const defs = registry.getDefinitions()
    expect(defs).toHaveLength(1)
    expect(defs[0].name).toBe('read')
    expect(defs[0].kind).toBe('built-in')
    expect(defs[0].parameters).toBeDefined()
  })
})
