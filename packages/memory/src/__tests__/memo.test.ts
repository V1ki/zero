import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { MemoManager } from '../memo'

const testDir = join(import.meta.dir, '__fixtures__')
const memoPath = join(testDir, 'memo.md')

describe('MemoManager', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('read returns default content when file missing', () => {
    const manager = new MemoManager(join(testDir, 'nonexistent-memo.md'))
    const content = manager.read()
    expect(content).toContain('# Memo')
    expect(content).toContain('## Goals')
  })

  test('write and read round-trip', async () => {
    mkdirSync(testDir, { recursive: true })
    const manager = new MemoManager(memoPath)
    const content = '# Memo\n\n## Goals\n- Build v1.0\n'

    await manager.write(content)
    const result = manager.read()
    expect(result).toBe(content)
  })

  test('updateAgentSection adds new section', async () => {
    mkdirSync(testDir, { recursive: true })
    const manager = new MemoManager(memoPath)
    await manager.write('# Memo\n\n## Goals\n- Build v1.0\n')

    await manager.updateAgentSection('Coder Agent', 'Building model layer', 'Run tests next')

    const result = manager.read()
    expect(result).toContain('### Coder Agent')
    expect(result).toContain('Building model layer')
    expect(result).toContain('Run tests next')
  })

  test('updateAgentSection updates existing section', async () => {
    const manager = new MemoManager(memoPath)

    await manager.updateAgentSection('Coder Agent', 'Tests complete', 'Deploy to prod')

    const result = manager.read()
    expect(result).toContain('Tests complete')
    expect(result).toContain('Deploy to prod')
    expect(result).not.toContain('Building model layer')
  })

  test('addUserAction adds to needs section', async () => {
    mkdirSync(testDir, { recursive: true })
    const manager = new MemoManager(memoPath)
    await manager.write('# Memo\n\n## Goals\n\n## Needs User Action\n')

    await manager.addUserAction('Provide Telegram Bot Token')

    const result = manager.read()
    expect(result).toContain('Provide Telegram Bot Token')
  })

  test('addGoal adds to goals section', async () => {
    const manager = new MemoManager(memoPath)

    await manager.addGoal('Complete v2.0 release')

    const result = manager.read()
    expect(result).toContain('Complete v2.0 release')
  })
})

describe('MemoManager.updateAgentSection prefix collision (R6)', () => {
  const dir = join(import.meta.dir, '__fixtures__-r6')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('agent name that is a prefix of an existing section is not silently dropped', async () => {
    mkdirSync(dir, { recursive: true })
    const m = new MemoManager(join(dir, 'memo.md'))
    await m.updateAgentSection('Alpha', 'status-alpha', 'plan-alpha')
    await m.updateAgentSection('A', 'status-A-MARKER', 'plan-A')
    const content = m.read()
    // 两个 section 都在，A 的写入未被静默丢失
    expect(content).toContain('### Alpha\n')
    expect(content).toContain('### A\n')
    expect(content).toContain('status-A-MARKER')
    expect(content).toContain('status-alpha')
  })

  test('updating an existing section still replaces in place (no regression)', async () => {
    mkdirSync(dir, { recursive: true })
    const m = new MemoManager(join(dir, 'memo2.md'))
    await m.updateAgentSection('web', 'v1', 'p1')
    await m.updateAgentSection('web', 'v2-MARKER', 'p2')
    const content = m.read()
    expect(content).toContain('v2-MARKER')
    expect(content).not.toContain('v1') // 旧内容被替换
    expect((content.match(/### web\n/g) ?? []).length).toBe(1) // 不重复
  })
})

describe('MemoManager $-pattern safety (R7)', () => {
  const dir = join(import.meta.dir, '__fixtures__-r7')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('addGoal/addUserAction/updateAgentSection do not expand $& / $` / $N from free text', async () => {
    mkdirSync(dir, { recursive: true })
    const m = new MemoManager(join(dir, 'memo.md'))
    await m.addGoal('price is $&100 discount')
    await m.addUserAction('run `echo $`backtick')
    await m.updateAgentSection('web', 'matched $& and $1 group', 'plan $0')
    const content = m.read()
    expect(content).toContain('price is $&100 discount') // 原样保留
    expect(content).toContain('run `echo $`backtick')
    expect(content).toContain('matched $& and $1 group')
    expect(content).not.toContain('## Goals100') // $& 未被展开成 marker
  })
})

describe('MemoManager superset-header safety (R8)', () => {
  const dir = join(import.meta.dir, '__fixtures__-r8')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('addGoal does not corrupt a preceding superset header (## Goals Achieved)', async () => {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'memo.md')
    const m = new MemoManager(p)
    await m.write('# Memo\n\n## Goals Achieved\n- old done\n\n## Goals\n- active goal\n')
    await m.addGoal('NEW GOAL')
    const content = m.read()
    expect(content).toContain('## Goals Achieved') // 超集标题完好
    expect(content).toContain('- old done')
    expect(content).not.toContain('NEW GOAL Achieved') // 没拼到超集标题里
    expect(content).toMatch(/## Goals\n- NEW GOAL\n- active goal/) // 拼到了真正的 ## Goals
  })
})
