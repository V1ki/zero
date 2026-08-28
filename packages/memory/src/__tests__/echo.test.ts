import { describe, expect, test } from 'bun:test'
import { detectMemoryEcho } from '../echo'

describe('detectMemoryEcho', () => {
  test('latin distinctive tokens echoed in output mark memory used', () => {
    const used = detectMemoryEcho(
      [
        {
          id: 'mem_1',
          text: 'deploy uses composable pipeline via pnpm deploy --prod at apps/gateway',
        },
      ],
      {
        userMessage: 'how do I deploy?',
        outputText: 'run pnpm deploy --prod in apps/gateway using the composable pipeline',
      },
    )
    expect(used).toEqual(['mem_1'])
  })

  test('tokens already in user message are excluded (echoing user words needs no memory)', () => {
    const used = detectMemoryEcho(
      [
        {
          id: 'mem_2',
          text: 'composable pipeline with pnpm at gateway',
        },
      ],
      {
        userMessage: 'tell me about the composable pipeline pnpm gateway setup',
        outputText: 'the composable pipeline with pnpm at gateway works like this',
      },
    )
    expect(used).toEqual([])
  })

  test('CJK bigram echo marks memory used', () => {
    const used = detectMemoryEcho(
      [
        {
          id: 'mem_3',
          text: '数据库连接池超时,建议调大 pool_size 并重启 postgres 服务',
        },
      ],
      {
        userMessage: '数据库报错了',
        outputText: '数据库连接超时,已调大 pool_size 并重启 postgres',
      },
    )
    expect(used).toEqual(['mem_3'])
  })

  test('stopped CJK bigrams do not count; two shared words stay under threshold', () => {
    const used = detectMemoryEcho(
      [
        {
          id: 'mem_4',
          text: '用户遇到了权限问题',
        },
      ],
      {
        userMessage: '别的主题',
        // 问题 在停用表;真正内容重合只有 权限/限问 两个 token,不足 3 个阈值
        outputText: '这个问题需要先确认权限',
      },
    )
    expect(used).toEqual([])
  })

  test('fewer than threshold distinct hits is not used', () => {
    const used = detectMemoryEcho([{ id: 'mem_5', text: 'alpha_config beta_flag gamma_mode' }], {
      userMessage: 'unrelated',
      outputText: 'only alpha_config appeared',
    })
    expect(used).toEqual([])
  })

  test('tool_use input counts as output evidence (action echo)', () => {
    const used = detectMemoryEcho(
      [
        {
          id: 'mem_6',
          text: '日志在 .zero/logs/runtime.log,用 grep zero-cli 排查',
        },
      ],
      {
        userMessage: '帮我查日志',
        // session-turn 会把工具调用拼成 "name JSON.stringify(input)" 后传入
        outputText: 'bash {"command":"grep zero-cli .zero/logs/runtime.log"}',
      },
    )
    expect(used).toEqual(['mem_6'])
  })

  test('empty memories returns empty', () => {
    expect(detectMemoryEcho([], { userMessage: 'x', outputText: 'y' })).toEqual([])
  })

  test('custom threshold is respected', () => {
    const memories = [{ id: 'mem_7', text: 'alpha_config beta_flag gamma_mode delta_switch' }]
    const turn = { userMessage: 'unrelated', outputText: 'alpha_config beta_flag gamma_mode' }
    expect(detectMemoryEcho(memories, turn)).toEqual(['mem_7'])
    expect(detectMemoryEcho(memories, turn, { minDistinctHits: 4 })).toEqual([])
  })
})
