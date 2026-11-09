import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { entityBase, rebuildEntityAssets, runEntityResolution } from './entity-resolution'
import { assetId, evidenceKey, resolveAssets, validateExtraction } from './extraction'
import { mentionAddress } from './identity-ledger'
import { verifyAliasMigration } from './migrate-aliases'
import { ENTITY_WORK_ROOT } from './resolve-entities'
import { ProjectStore, atomicJson } from './store'

// Real model acceptance on isolated controlled text. Never writes the live project
// and never calls extraction. Expected identities here are test assertions only.
const cases = [
  {
    name: '匿名跨章揭名',
    names: ['女子', '沈青'],
    targets: ['沈青'],
    lines: [
      '女子在桥下教林舟练霜剑，左腕有一道月牙伤痕，她未透露姓名。',
      '沈青站在窗前静静望着河水，没有说话。\n沈青就是当初在桥下教林舟霜剑的那名女子，林舟认出了她左腕的月牙伤痕。',
    ],
  },
  {
    name: '不同女子分别归属',
    names: ['女子', '女子', '沈青', '陆红'],
    targets: ['沈青', '陆红'],
    lines: [
      '女子在桥下教林舟练霜剑，左腕有一道月牙伤痕，她未透露姓名。',
      '女子在东城卖花，右手缺了小指，她不认识林舟，更不会练剑。',
      '沈青就是当初在桥下教林舟练霜剑的女子，她左腕有一道月牙伤痕。',
      '陆红就是东城那名右手缺指的卖花女子，与沈青是两个不同的人。',
    ],
  },
  {
    name: '老人后续揭名',
    names: ['老人', '韩松'],
    targets: ['韩松'],
    lines: [
      '老人在寺外独自敲响铜钟，他的左手有六根手指，所有人都不知他的名字。',
      '韩松就是寺外那位六指老人，村长认出了他，喊出姓名，两人相拥而泣。',
    ],
  },
  {
    name: '同类经历不足以确认',
    names: ['女刺客', '沈青', '陆红'],
    targets: [null],
    lines: [
      '女刺客在夜里翻墙而过，脸被遮住，无人知道她的身份和来历。',
      '沈青擅长剑术，她常在夜间行动，但没有证据表明她就是那名女刺客。',
      '陆红也擅长剑术，喜欢蒙面出门，无法确认她是否曾经翻过那道墙。',
    ],
  },
]

export async function acceptAnonymousResolution() {
  const directory = join(
    ENTITY_WORK_ROOT,
    `anonymous-live-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  )
  mkdirSync(directory, { recursive: true })
  const results: { name: string; passed: boolean; [key: string]: unknown }[] = []
  for (const sample of cases) {
    const store = new ProjectStore(join(directory, 'projects'))
    const source = sample.lines.map((line, i) => `第${i + 1}章\n${line}\n`).join('')
    const { progress: _, ...p } = store.import(sample.name, source)
    for (const [i, chunk] of p.chunks.entries()) {
      chunk.status = 'succeeded'
      chunk.mentions = validateExtraction(
        JSON.stringify({
          assets: [
            {
              kind: 'character',
              name: sample.names[i],
              aliases: [],
              description: sample.lines[i].split('\n')[0],
              quote: sample.lines[i].split('\n')[0],
            },
          ],
        }),
        source,
        chunk,
        p.chapters[i],
      )
    }
    Object.assign(p, resolveAssets(p.chunks))
    const before = structuredClone(p)
    const subjects = entityBase(p).assets.filter((a) => a.localIdentity)
    mkdirSync(join(store.directory(p.id), 'entity-attempts'), { recursive: true })
    try {
      await runEntityResolution(
        p,
        source,
        subjects.map((a) => a.id),
        {
          transport: fetch,
          save: () => atomicJson(join(store.directory(p.id), 'project.json'), p),
          artifact: (path, value) => atomicJson(join(store.directory(p.id), path), value),
        },
      )
      Object.assign(p, rebuildEntityAssets(p))
      const actual = subjects.map(
        (a) =>
          p.identityResolution?.mentionRedirects?.[
            mentionAddress(a.id, evidenceKey(a.evidence[0]))
          ],
      )
      const expected = sample.targets.map((name, i) =>
        name ? assetId('character', name) : subjects[i].id,
      )
      const passed =
        JSON.stringify(actual) === JSON.stringify(expected) &&
        !p.assets.some((a) => a.aliases.some((n) => ['女子', '女刺客', '老人'].includes(n))) &&
        !p.identityResolution?.conflicts?.length
      results.push({
        name: sample.name,
        passed,
        expected,
        actual,
        counts: verifyAliasMigration(before, p),
        decisions: p.identityResolution?.ai?.decisions,
        attempts: p.identityResolution?.ai?.attempts,
      })
      atomicJson(join(store.directory(p.id), 'project.json'), p)
    } catch (error) {
      results.push({
        name: sample.name,
        passed: false,
        error: String(error),
        attempts: p.identityResolution?.ai?.attempts,
      })
      atomicJson(join(directory, 'results.json'), {
        source: 'real Qwen; controlled mentions, not extraction',
        results,
        unrunCases: cases.slice(results.length).map((s) => s.name),
      })
      throw new Error(`真实匿名消歧验收阻塞：${directory}/results.json；${String(error)}`)
    }
  }
  atomicJson(join(directory, 'results.json'), {
    source: 'real Qwen; controlled mentions, not extraction',
    results,
  })
  if (results.some((r) => !r.passed))
    throw new Error(`真实匿名消歧语义验收失败：${directory}/results.json`)
  return directory
}
if (import.meta.main) console.log(await acceptAnonymousResolution())
