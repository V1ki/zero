import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BashTool } from '../bash'
import { EditTool } from '../edit'
import { ReadTool } from '../read'
import { ToolRegistry } from '../registry'
import { WriteTool } from '../write'

const testDir = join(import.meta.dir, '__fixtures__')
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
