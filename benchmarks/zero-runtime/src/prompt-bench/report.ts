import type { Trial } from './engine'
import { hash } from './snapshot'

export function comparePairs(results: Trial[], baseline: string, candidate: string) {
  const groups = new Map<string, Trial[]>()
  for (const row of results) {
    const key = `${row.model}/${row.caseId}/${row.rep}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  let wins = 0
  let losses = 0
  let ties = 0
  let excluded = 0
  for (const group of groups.values()) {
    const before = group.find((r) => r.variant === baseline)
    const after = group.find((r) => r.variant === candidate)
    if (!before || !after || before.status !== 'ok' || after.status !== 'ok') {
      excluded++
      continue
    }
    if (after.passed && !before.passed) wins++
    else if (before.passed && !after.passed) losses++
    else ties++
  }
  return { wins, losses, ties, excluded }
}

export function renderReport(results: Trial[], baseline: string, candidate: string): string {
  const lines = [
    '# ZeRo 提示词对照结果',
    '',
    '同一模型内比较新旧提示词。主任务使用真实模型和模拟工具；收尾判定使用预先标注场景，标签仍需人工复核。不是完整 ZeRo 端到端测试。',
    '',
    '| 模型 | 版本 | 任务通过 | 收尾通过 | 错误/超时 | 越界尝试 | 平均请求数 | 平均未缓存输入/输出 token | 平均耗时秒 |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ]
  const models = [...new Set(results.map((r) => r.model))]
  for (const model of models)
    for (const variant of [baseline, candidate]) {
      const rows = results.filter((r) => r.model === model && r.variant === variant)
      const main = rows.filter((r) => !r.caseId.startsWith('closure-'))
      const closure = rows.filter((r) => r.caseId.startsWith('closure-'))
      const ok = rows.filter((r) => r.status === 'ok')
      const avg = (fn: (row: Trial) => number) =>
        ok.length ? (ok.reduce((n, r) => n + fn(r), 0) / ok.length).toFixed(1) : '—'
      lines.push(
        `| ${model} | ${variant} | ${main.filter((r) => r.passed).length}/${main.length} | ${closure.filter((r) => r.passed).length}/${closure.length} | ${rows.length - ok.length} | ${rows.reduce((n, r) => n + (r.grade?.unauthorizedEffects.length ?? 0), 0)} | ${avg((r) => r.requests)} | ${avg((r) => r.usage.input)} / ${avg((r) => r.usage.output)} | ${avg((r) => r.durationMs / 1000)} |`,
      )
    }
  lines.push(
    '',
    '## 配对结果',
    '',
    '赢/输以同模型、同场景、同重复序号的通过状态比较；错误或缺失结果不算平局。',
    '',
  )
  for (const model of models) {
    const pairs = comparePairs(
      results.filter((r) => r.model === model),
      baseline,
      candidate,
    )
    lines.push(
      `- ${model}：候选赢 ${pairs.wins}，输 ${pairs.losses}，平 ${pairs.ties}，排除 ${pairs.excluded} 对。`,
    )
    const before = results.filter(
      (r) => r.model === model && r.variant === baseline && r.status === 'ok' && r.passed,
    )
    const paired = before.flatMap((a) => {
      const b = results.find(
        (r) =>
          r.model === model &&
          r.variant === candidate &&
          r.caseId === a.caseId &&
          r.rep === a.rep &&
          r.status === 'ok' &&
          r.passed,
      )
      return b ? [{ a, b }] : []
    })
    if (paired.length) {
      const delta = (fn: (r: Trial) => number) =>
        (paired.reduce((n, p) => n + fn(p.b) - fn(p.a), 0) / paired.length).toFixed(1)
      lines.push(
        `  同对均通过 ${paired.length} 对：平均未缓存输入 token 差 ${delta((r) => r.usage.input)}，缓存读取差 ${delta((r) => r.usage.cacheRead ?? 0)}，输出差 ${delta((r) => r.usage.output)}，耗时差 ${delta((r) => r.durationMs / 1000)} 秒（候选减基线）。`,
      )
    }
  }
  lines.push('', '## 未通过与异常', '')
  for (const r of results.filter((r) => !r.passed)) {
    const checks = r.grade
      ? Object.entries(r.grade.checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => name)
          .join(', ')
      : `${r.decision ?? r.status} / expected=${r.expected ?? 'n/a'}`
    lines.push(
      `- ${r.model} · ${r.variant} · ${r.caseId} · 第 ${r.rep} 次：${checks}${r.error ? `；${r.error.slice(0, 160).replaceAll('\n', ' ')}` : ''}`,
    )
  }
  if (results.some((r) => r.emptyResponses !== undefined)) {
    lines.push(
      '',
      '## 空回复诊断',
      '',
      '空回复次数、同请求重试次数、恢复次数分别记录；开启重试也不将持续空回复计为通过。',
      '',
    )
    for (const model of models)
      for (const variant of [baseline, candidate]) {
        const rows = results.filter((r) => r.model === model && r.variant === variant)
        const sum = (key: 'emptyResponses' | 'emptyRetries' | 'emptyRecovered') =>
          rows.reduce((n, r) => n + (r[key] ?? 0), 0)
        lines.push(
          `- ${model} · ${variant}：空回复 ${sum('emptyResponses')}，重试 ${sum('emptyRetries')}，恢复 ${sum('emptyRecovered')}。`,
        )
      }
  }
  lines.push(
    '',
    '## 解读限制',
    '',
    '- 通过率包含所有尝试；平均成本仅统计正常返回的试验，不把超时未知用量当成零。延迟含工具循环，受网络与缓存影响。',
    '- token 为 adapter 归一化的 usage：input 是未缓存部分，不含 cacheRead/cacheWrite；缓存命中变化会影响该数值。未估算费用，不同模型不能仅凭 token 数判断价格。缓存和推理 token、实际响应模型见原始结果。',
    '- 确认次数由关键词估计，只作诊断；事实关键词和产物检查覆盖有限，不能代替人工语义评审。',
    '- review.jsonl 隐去版本标签供人工审阅；对应关系单独保存在 review-key.json。',
    '- 少量合成场景的赢/输是方向性证据，不是显著性结论。重复运行不等于新增独立场景。',
    '- 接受新版本前，先检查新增越界/泄密及任务退步，再比较质量相当任务的成本；不要只优化通过这组题。',
    '',
  )
  return lines.join('\n')
}

export function blindReview(results: Trial[]) {
  return results
    .map((row) => {
      const id = hash(row.id).slice(0, 16)
      return {
        id,
        caseId: row.caseId,
        model: row.model,
        rep: row.rep,
        messages: row.messages,
        observations: row.observations,
      }
    })
    .sort((a, b) => a.id.localeCompare(b.id))
}
