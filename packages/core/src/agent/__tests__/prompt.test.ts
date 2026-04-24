import { describe, expect, test } from 'bun:test'
import {
  buildBootstrapContextBlock,
  buildConstraintsBlock,
  buildDynamicContext,
  buildExecutionModeBlock,
  buildIdentityBlock,
  buildMemoryPolicyBlock,
  buildOutputStyleBlock,
  buildRetrievedMemoriesBlock,
  buildRoleBlock,
  buildRulesBlock,
  buildRuntimeBlock,
  buildSafetyBlock,
  buildSkillCatalog,
  buildSkillReminder,
  buildSystemPrompt,
  buildToolCallStyleBlock,
  buildToolRulesBlock,
} from '../prompt'

const makeTool = (name: string): import('@zero-os/shared').ToolDefinition => ({
  name,
  description: `${name} tool`,
  parameters: {},
})

const makeSkill = (
  name: string,
  description = 'A test skill.',
): import('@zero-os/shared').SkillDefinition => ({
  name,
  description,
  allowedTools: ['bash'],
  content: `# ${name} Skill\n\nFull content here.`,
  sourcePath: `/path/to/skills/${name}/SKILL.md`,
})

const makeBootstrapFile = (
  name: string,
  content: string,
): import('@zero-os/shared').BootstrapFile => ({
  name,
  path: `/project/.zero/${name}`,
  content,
})

describe('buildRoleBlock', () => {
  test('contains agent name and description in XML tags', () => {
    const result = buildRoleBlock('Coder', '负责编写和修改代码')

    expect(result).toContain('<role>')
    expect(result).toContain('</role>')
    expect(result).toContain('Coder')
    expect(result).toContain('负责编写和修改代码')
    expect(result).toContain('ZeRo OS')
  })

  test('includes workspace and project paths when provided', () => {
    const result = buildRoleBlock('Coder', '负责编写代码', '/workspace/coder', '/project')

    expect(result).toContain('/workspace/coder')
    expect(result).toContain('/project')
  })
})

describe('buildRulesBlock', () => {
  test('returns 8 rules in <rules> tags', () => {
    const result = buildRulesBlock()

    expect(result).toStartWith('<rules>')
    expect(result).toEndWith('</rules>')

    // Verify all 8 rules are present
    expect(result).toContain('执行操作前先说明意图')
    expect(result).toContain('工具调用失败时先读错误信息做诊断')
    expect(result).toContain('涉及不可逆操作')
    expect(result).toContain('遇到超出能力范围的问题时如实告知')
    expect(result).toContain('回复使用中文')
    expect(result).toContain('每完成一个阶段性目标后')
    expect(result).toContain('阶段性汇报用于同步进度')
    expect(result).toContain('<system-reminder> 是系统注入的内部运行时提示')

    // Count lines inside the tags (8 rules = 8 lines)
    const inner = result.replace('<rules>\n', '').replace('\n</rules>', '')
    const lines = inner.split('\n').filter((l) => l.trim().length > 0)
    expect(lines.length).toBe(8)
  })
})

describe('buildOutputStyleBlock', () => {
  test('wraps channel delivery guidance in <output_style> tags', () => {
    const result = buildOutputStyleBlock()

    expect(result).toContain('<output_style>')
    expect(result).toContain('</output_style>')
    expect(result).toContain('会直接显示在当前 channel 中')
    expect(result).toContain('不要为了把内容发回当前用户，再额外调用发送工具')
    expect(result).toContain('以 channel capabilities 为准')
    expect(result).toContain('必须在回复中直接写出来')
  })
})

describe('buildExecutionModeBlock', () => {
  test('wraps continuous execution guidance in <execution_mode> tags', () => {
    const result = buildExecutionModeBlock()

    expect(result).toContain('<execution_mode>')
    expect(result).toContain('</execution_mode>')
    expect(result).toContain('默认工作模式：连续自治执行')
    expect(result).toContain('不要因为完成了一个子步骤')
    expect(result).toContain('只有在以下情况才暂停并请求用户介入')
    expect(result).toContain('低成本后续验证')
    expect(result).toContain('用户明确要求你列出后续选项')
  })
})

describe('buildMemoryPolicyBlock', () => {
  test('wraps memory policy guidance in <memory_policy> tags', () => {
    const result = buildMemoryPolicyBlock()

    expect(result).toContain('<memory_policy>')
    expect(result).toContain('</memory_policy>')
    expect(result).toContain('会话中产生以下任何一种信息时，应主动写入 memory')
    expect(result).toContain('优先 memory.update')
    expect(result).toContain('临时排查日志')
    expect(result).toContain('incident：值得复盘和复用的故障案例')
    expect(result).toContain('session：由系统自动管理，不需要手动创建')
  })
})

describe('buildToolRulesBlock', () => {
  test('generates rules only for available tools', () => {
    const tools = [
      makeTool('Read'),
      makeTool('read_image'),
      makeTool('Bash'),
      makeTool('memory_search'),
      makeTool('memory_read'),
      makeTool('memory'),
    ]
    const result = buildToolRulesBlock(tools)

    expect(result).toContain('<tool_rules>')
    expect(result).toContain('</tool_rules>')
    expect(result).toContain('Read：优先使用 Read 查看文件内容')
    expect(result).toContain('Read Image：用于读取本地 PNG/JPEG/WebP 图片')
    expect(result).toContain('Bash：命令在工作目录中执行')
    expect(result).toContain('Memory Search：回答过往工作、决策、偏好前')
    expect(result).toContain('支持语义搜索')
    expect(result).toContain('Memory Read：根据 memory_search 返回的 path')
    expect(result).toContain('仅在 snippet 不足以回答时使用')
    expect(result).toContain('每个阶段性成果完成时就评估')
    // Should not contain rules for tools not in the list
    expect(result).not.toContain('Write：')
    expect(result).not.toContain('Edit：')
    expect(result).not.toContain('Fetch：')
    expect(result).not.toContain('Task：')
  })

  test('returns empty tag when no matching tools', () => {
    const tools = [makeTool('UnknownTool')]
    const result = buildToolRulesBlock(tools)

    expect(result).toBe('<tool_rules>\n</tool_rules>')
  })
})

describe('buildConstraintsBlock', () => {
  test('wraps constraints in <constraints> tags', () => {
    const result = buildConstraintsBlock()

    expect(result).toContain('<constraints>')
    expect(result).toContain('</constraints>')
    expect(result).toContain('不得包含密钥值')
    expect(result).toContain('代码修改后必须通过至少一种验证')
    expect(result).toContain('docs/zero-cli.md')
    expect(result).toContain('不要主动建议或执行未列出的 Zero 命令')
    expect(result).toContain('单次回复不超过 2000 字')
  })
})

describe('buildSafetyBlock', () => {
  test('wraps safety rules in <safety> tags', () => {
    const result = buildSafetyBlock()

    expect(result).toContain('<safety>')
    expect(result).toContain('</safety>')
    expect(result).toContain('没有独立目标')
    expect(result).toContain('不要把人类监督理解为每一步都要审批')
    expect(result).toContain('不操纵或说服')
  })
})

describe('buildToolCallStyleBlock', () => {
  test('wraps style guidance in <tool_call_style> tags', () => {
    const result = buildToolCallStyleBlock()

    expect(result).toContain('<tool_call_style>')
    expect(result).toContain('</tool_call_style>')
    expect(result).toContain('默认')
    expect(result).toContain('低风险')
    expect(result).toContain('解说要简洁')
  })
})

describe('buildIdentityBlock', () => {
  test('renders both global and agent sections', () => {
    const result = buildIdentityBlock('全局身份信息', '代理身份信息', 'Coder')

    expect(result).toContain('<identity>')
    expect(result).toContain('</identity>')
    expect(result).toContain('<global>')
    expect(result).toContain('全局身份信息')
    expect(result).toContain('</global>')
    expect(result).toContain('<agent name="Coder">')
    expect(result).toContain('代理身份信息')
    expect(result).toContain('</agent>')
  })

  test('handles empty global identity', () => {
    const result = buildIdentityBlock('', '代理身份信息', 'Coder')

    expect(result).toContain('<identity>')
    expect(result).toContain('</identity>')
    expect(result).not.toContain('<global>')
    expect(result).toContain('<agent name="Coder">')
    expect(result).toContain('代理身份信息')
  })

  test('handles empty agent identity', () => {
    const result = buildIdentityBlock('全局身份信息', '', 'Coder')

    expect(result).toContain('<identity>')
    expect(result).toContain('</identity>')
    expect(result).toContain('<global>')
    expect(result).toContain('全局身份信息')
    expect(result).not.toContain('<agent')
  })
})

describe('buildSkillCatalog', () => {
  test('renders skill metadata in <skill_catalog> tags', () => {
    const skills = [
      makeSkill('browser', '通过 agent-browser CLI 控制浏览器。\n触发词：浏览器、打开网页。'),
    ]
    const result = buildSkillCatalog(skills)

    expect(result).toContain('<skill_catalog>')
    expect(result).toContain('</skill_catalog>')
    expect(result).toContain('name="browser"')
    expect(result).toContain('path="/path/to/skills/browser/SKILL.md"')
    expect(result).toContain('agent-browser CLI')
    expect(result).toContain('使用 Read 工具读取其 SKILL.md')
  })

  test('includes skill reading constraint', () => {
    const skills = [makeSkill('browser')]
    const result = buildSkillCatalog(skills)

    expect(result).toContain('每次最多读取一个 Skill')
  })

  test('does not include full skill content', () => {
    const skills = [makeSkill('browser')]
    const result = buildSkillCatalog(skills)

    expect(result).not.toContain('Full content here')
  })

  test('returns empty string for no skills', () => {
    expect(buildSkillCatalog([])).toBe('')
  })

  test('renders multiple skills', () => {
    const skills = [makeSkill('browser'), makeSkill('awiki')]
    const result = buildSkillCatalog(skills)

    expect(result).toContain('name="browser"')
    expect(result).toContain('name="awiki"')
  })
})

describe('buildDynamicContext', () => {
  test('returns empty string when there are no new skills', () => {
    const result = buildDynamicContext({})
    expect(result).toBe('')
  })

  test('includes new skills when present', () => {
    const result = buildDynamicContext({
      newSkills: [makeSkill('awiki')],
    })

    expect(result).toContain('<system-reminder>')
    expect(result).toContain('</system-reminder>')
    expect(result).toContain('<new_skills>')
    expect(result).toContain('name="awiki"')
    expect(result).toContain('SKILL.md')
  })

  test('omits new_skills when undefined', () => {
    const result = buildDynamicContext({})
    expect(result).toBe('')
  })

  test('returns empty when only retrievedMemories is empty string', () => {
    const result = buildDynamicContext({
      retrievedMemories: '',
    })
    expect(result).toBe('')
  })

  test('includes retrieved memories when present', () => {
    const result = buildDynamicContext({
      retrievedMemories:
        '<retrieved_memories>\n  <memory id="m1" type="note">demo</memory>\n</retrieved_memories>',
    })

    expect(result).toContain('<system-reminder>')
    expect(result).toContain('<retrieved_memories>')
    expect(result).toContain('type="note"')
  })

  test('includes both new skills and retrieved memories', () => {
    const result = buildDynamicContext({
      newSkills: [makeSkill('awiki')],
      retrievedMemories:
        '<retrieved_memories>\n  <memory id="m1" type="note">demo</memory>\n</retrieved_memories>',
    })

    expect(result).toContain('<new_skills>')
    expect(result).toContain('<retrieved_memories>')
  })
})

describe('buildRetrievedMemoriesBlock', () => {
  test('returns empty string for empty array', () => {
    expect(buildRetrievedMemoriesBlock([])).toBe('')
  })

  test('renders XML with id, type, title, and content', () => {
    const result = buildRetrievedMemoriesBlock([
      {
        id: 'mem_1',
        type: 'preference',
        title: 'Twitter 访问偏好',
        content: '优先使用 browser <skill>',
        score: 0.853,
      },
    ])

    expect(result).toContain('<retrieved_memories>')
    expect(result).toContain('id="mem_1"')
    expect(result).toContain('type="preference"')
    expect(result).not.toContain('score=')
    expect(result).toContain('<title>Twitter 访问偏好</title>')
    expect(result).toContain('browser &lt;skill&gt;')
  })

  test('handles multiple memories', () => {
    const result = buildRetrievedMemoriesBlock([
      {
        id: 'mem_1',
        type: 'preference',
        title: 'one',
        content: 'first',
        score: 0.9,
      },
      {
        id: 'mem_2',
        type: 'decision',
        title: 'two',
        content: 'second',
        score: 0.8,
      },
    ])

    expect(result).toContain('id="mem_1"')
    expect(result).toContain('id="mem_2"')
  })
})

describe('buildSkillReminder', () => {
  test('renders new skill notification', () => {
    const skills = [makeSkill('awiki', '搜索和查询 wiki 内容。')]
    const result = buildSkillReminder(skills)

    expect(result).toContain('<new_skills>')
    expect(result).toContain('</new_skills>')
    expect(result).toContain('name="awiki"')
    expect(result).toContain('path="/path/to/skills/awiki/SKILL.md"')
    expect(result).toContain('Read 工具读取 SKILL.md')
  })
})

describe('buildRuntimeBlock', () => {
  test('renders compact key=value runtime info', () => {
    const result = buildRuntimeBlock({
      agentId: 'zero',
      sessionId: 'sess_123',
      host: 'mac-mini',
      os: 'darwin',
      arch: 'arm64',
      model: 'gpt-5.3-codex-medium',
      shell: 'zsh',
      projectRoot: '/Users/x/project',
    })

    expect(result).toContain('<runtime>')
    expect(result).toContain('</runtime>')
    expect(result).toContain('agent=zero')
    expect(result).toContain('session=sess_123')
    expect(result).toContain('host=mac-mini')
    expect(result).toContain('os=darwin (arm64)')
    expect(result).toContain('model=gpt-5.3-codex-medium')
    expect(result).toContain('shell=zsh')
    expect(result).toContain('repo=/Users/x/project')
  })

  test('omits missing fields', () => {
    const result = buildRuntimeBlock({
      model: 'gpt-5.3-codex-medium',
    })

    expect(result).toContain('model=gpt-5.3-codex-medium')
    expect(result).not.toContain('agent=')
    expect(result).not.toContain('host=')
    expect(result).not.toContain('shell=')
  })

  test('returns empty string when no info', () => {
    const result = buildRuntimeBlock({})
    expect(result).toBe('')
  })

  test('renders channel capability details for inline images', () => {
    const result = buildRuntimeBlock({
      channel: 'feishu',
      channelCapabilities: {
        inlineImages: true,
        markdownNotes:
          'Inline images can use img_xxx, local absolute paths, file:// URIs, or http(s) URLs.',
      },
    })

    expect(result).toContain('channel=feishu')
    expect(result).toContain('Inline images: supported')
    expect(result).toContain('local absolute paths')
    expect(result).toContain('file:// URIs')
    expect(result).toContain('http(s) URLs')
  })
})

describe('buildBootstrapContextBlock', () => {
  test('renders bootstrap files in <project_context> tags', () => {
    const files = [
      makeBootstrapFile('AGENTS.md', '# Workspace Rules\n\nDo this.'),
      makeBootstrapFile('TOOLS.md', '# Tool Notes\n\nBash tips.'),
    ]
    const result = buildBootstrapContextBlock(files)

    expect(result).toContain('<project_context>')
    expect(result).toContain('</project_context>')
    expect(result).toContain('## AGENTS.md')
    expect(result).toContain('Workspace Rules')
    expect(result).toContain('## TOOLS.md')
    expect(result).toContain('Bash tips')
  })

  test('adds persona instruction when SOUL.md is present', () => {
    const files = [
      makeBootstrapFile('SOUL.md', '# Who You Are\n\nBe genuine.'),
      makeBootstrapFile('AGENTS.md', '# Rules'),
    ]
    const result = buildBootstrapContextBlock(files)

    expect(result).toContain('SOUL.md')
    expect(result).toContain('体现其人格和语调')
  })

  test('does not add persona instruction without SOUL.md', () => {
    const files = [makeBootstrapFile('AGENTS.md', '# Rules')]
    const result = buildBootstrapContextBlock(files)

    expect(result).not.toContain('体现其人格和语调')
  })

  test('returns empty string for no files', () => {
    expect(buildBootstrapContextBlock([])).toBe('')
  })
})

describe('buildSystemPrompt', () => {
  const baseComponents = {
    agentName: 'Coder',
    agentDescription: '负责编写代码',
    tools: [makeTool('Read'), makeTool('Write'), makeTool('memory')],
    globalIdentity: '全局身份',
    agentIdentity: '代理身份',
  }

  test('assembles all sections in full mode (default)', () => {
    const result = buildSystemPrompt(baseComponents)

    expect(result).toContain('<role>')
    expect(result).toContain('<rules>')
    expect(result).toContain('<execution_mode>')
    expect(result).toContain('<tool_rules>')
    expect(result).toContain('<memory_policy>')
    expect(result).toContain('<constraints>')
    expect(result).toContain('<safety>')
    expect(result).toContain('<tool_call_style>')
    expect(result).toContain('<identity>')
    // Should NOT contain dynamic content
    expect(result).not.toContain('<memo>')
    expect(result).not.toContain('<retrieved_memories>')
    expect(result).not.toContain('<new_skills>')
  })

  test('includes skill_catalog when skills provided', () => {
    const result = buildSystemPrompt({
      ...baseComponents,
      skills: [makeSkill('browser')],
    })

    expect(result).toContain('<skill_catalog>')
    expect(result).toContain('name="browser"')
    expect(result).not.toContain('Full content here')
  })

  test('omits skill_catalog when no skills', () => {
    const result = buildSystemPrompt(baseComponents)

    expect(result).not.toContain('<skill_catalog>')
  })

  test('omits memory_policy when memory tools are unavailable', () => {
    const result = buildSystemPrompt({
      ...baseComponents,
      tools: [makeTool('Read'), makeTool('Write')],
    })

    expect(result).not.toContain('<memory_policy>')
  })

  test('includes runtime info when provided', () => {
    const result = buildSystemPrompt({
      ...baseComponents,
      runtimeInfo: { model: 'gpt-5.3-codex-medium', shell: 'zsh' },
    })

    expect(result).toContain('<runtime>')
    expect(result).toContain('model=gpt-5.3-codex-medium')
  })

  test('includes output_style for channel sessions', () => {
    const result = buildSystemPrompt({
      ...baseComponents,
      runtimeInfo: { channel: 'feishu', model: 'gpt-5.3-codex-medium' },
    })

    expect(result).toContain('<output_style>')
    expect(result).toContain('你的回复会直接显示在当前 channel 中')
  })

  test('omits output_style when no channel is present', () => {
    const result = buildSystemPrompt({
      ...baseComponents,
      runtimeInfo: { model: 'gpt-5.3-codex-medium' },
    })

    expect(result).not.toContain('<output_style>')
  })

  test('includes bootstrap files as project context', () => {
    const result = buildSystemPrompt({
      ...baseComponents,
      bootstrapFiles: [
        makeBootstrapFile('SOUL.md', '# Who You Are'),
        makeBootstrapFile('AGENTS.md', '# Rules'),
      ],
    })

    expect(result).toContain('<project_context>')
    expect(result).toContain('## SOUL.md')
    expect(result).toContain('## AGENTS.md')
  })

  describe('PromptMode: minimal', () => {
    test('includes only core sections', () => {
      const result = buildSystemPrompt({
        ...baseComponents,
        tools: [makeTool('Read'), makeTool('memory')],
        promptMode: 'minimal',
      })

      expect(result).toContain('<role>')
      expect(result).toContain('<tool_rules>')
      expect(result).toContain('<memory_policy>')
      expect(result).toContain('<constraints>')
      expect(result).toContain('docs/zero-cli.md')
      // Full-only sections should be absent
      expect(result).not.toContain('<rules>')
      expect(result).not.toContain('<safety>')
      expect(result).not.toContain('<tool_call_style>')
      expect(result).not.toContain('<identity>')
      expect(result).not.toContain('<skill_catalog>')
      expect(result).not.toContain('<runtime>')
    })

    test('still includes bootstrap files (filtered by mode externally)', () => {
      const result = buildSystemPrompt({
        ...baseComponents,
        promptMode: 'minimal',
        bootstrapFiles: [makeBootstrapFile('AGENTS.md', '# Rules')],
      })

      expect(result).toContain('<project_context>')
      expect(result).toContain('## AGENTS.md')
    })
  })

  describe('PromptMode: none', () => {
    test('returns only identity line', () => {
      const result = buildSystemPrompt({
        ...baseComponents,
        promptMode: 'none',
      })

      expect(result).toContain('ZeRo OS')
      expect(result).toContain('Coder')
      expect(result).not.toContain('<role>')
      expect(result).not.toContain('<rules>')
      expect(result).not.toContain('<tool_rules>')
      expect(result).not.toContain('<constraints>')
    })
  })
})
