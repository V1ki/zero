import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { entityFrames, rebuildEntityAssets, runEntityResolution } from './entity-resolution'
import { assetId, resolveAssetId, resolveAssets, validateExtraction } from './extraction'
import { verifyAliasMigration } from './migrate-aliases'
import { ENTITY_WORK_ROOT } from './resolve-entities'
import { ProjectStore, atomicJson } from './store'
import type { AssetKind } from './types'

// Controlled source/mentions isolate identity reasoning. Replies come ONLY from
// the real configured Qwen endpoint; this is not a model-extraction recall test.
const cases: {
  name: string
  kind: AssetKind
  names: string[]
  lines: string[]
  target?: string
}[] = [
  {
    name: '人物简称先出现',
    kind: 'character',
    names: ['阿青', '沈青'],
    target: '沈青',
    lines: [
      '阿青是村里唯一的铁匠，右手缺了小指，今日独自在炉前打铁。',
      '沈青走进衙门报上姓名，差役笑道：“原来是村里那位右手缺了小指的铁匠阿青。”沈青点头应下。',
    ],
  },
  {
    name: '场景简称和其他府邸',
    kind: 'location',
    names: ['侯府', '靖安侯府', '定远侯府'],
    target: '靖安侯府',
    lines: [
      '陈实回到侯府，门口写着靖安二字，顾家的老门房迎了出来。',
      '靖安侯府是顾家的祖宅，陈实在这座宅子里当差多年。',
      '定远侯府在河对岸，属于林家，与顾家的宅子是两处不同的府邸。',
    ],
  },
  {
    name: '道具异名',
    kind: 'prop',
    names: ['黑刃', '玄铁刀'],
    target: '玄铁刀',
    lines: [
      '黑刃的刀柄嵌着三颗红玉，刀背刻有沈家祖传的独特家徽。',
      '他将玄铁刀交给儿子，指着刀柄的三颗红玉说：“这把祖传的黑刃，现在归你了。”',
    ],
  },
  {
    name: '通称多个实际归属',
    kind: 'location',
    names: ['侯府', '侯府', '靖安侯府', '定远侯府'],
    lines: [
      '陈实走进侯府，这里是顾家居住的靖安侯府。',
      '林明回到侯府，他回的是林家的定远侯府，绝不是顾家的宅子。',
      '靖安侯府是顾家世代居住的宅子，陈实在这里当差。',
      '定远侯府是林家世代居住的宅子，林明在这里生活。',
    ],
  },
  {
    name: '无身份关系证据',
    kind: 'prop',
    names: ['黑刃', '玄铁刀'],
    lines: [
      '黑刃摆在商铺柜台上，是一把普通的长刀。',
      '玄铁刀摆在另一家商铺里，没有人知道它以前的来历。',
    ],
  },
]
cases.push({
  ...cases[0],
  name: '人物实名先出现',
  names: [...cases[0].names].reverse(),
  lines: [...cases[0].lines].reverse(),
})

export async function acceptEntityResolution() {
  const directory = join(
    ENTITY_WORK_ROOT,
    `live-samples-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  )
  mkdirSync(directory, { recursive: true })
  const results: unknown[] = []
  for (const sample of cases) {
    const store = new ProjectStore(join(directory, 'projects'))
    const source = sample.names.map((_name, i) => `第${i + 1}章\n${sample.lines[i]}\n`).join('')
    const view = store.import(sample.name, source)
    const { progress: _progress, ...project } = view
    for (const [i, chunk] of project.chunks.entries()) {
      chunk.mentions = validateExtraction(
        JSON.stringify({
          assets: [
            {
              kind: sample.kind,
              name: sample.names[i],
              aliases: [],
              description: '验收受控原文提及；不是模型抽取结果',
              quote: sample.lines[i],
            },
          ],
        }),
        source,
        chunk,
        project.chapters[i],
      )
      chunk.status = 'succeeded'
    }
    Object.assign(project, resolveAssets(project.chunks))
    const before = structuredClone(project)
    // The reverse-order case still selects the alias for review.
    const from = assetId(sample.kind, sample.kind === 'character' ? '阿青' : sample.names[0])
    mkdirSync(join(store.directory(project.id), 'entity-attempts'), { recursive: true })
    try {
      await runEntityResolution(project, source, [from], {
        transport: fetch,
        save: () => atomicJson(join(store.directory(project.id), 'project.json'), project),
        artifact: (path, value) => atomicJson(join(store.directory(project.id), path), value),
      })
      Object.assign(project, rebuildEntityAssets(project))
      const target = resolveAssetId(project, from)
      const expected = sample.target ? assetId(sample.kind, sample.target) : from
      const passed = target?.id === expected
      const counts = verifyAliasMigration(before, project)
      results.push({
        name: sample.name,
        passed,
        expected,
        actual: target?.id,
        counts,
        decisions: project.identityResolution?.ai?.decisions,
        attempts: project.identityResolution?.ai?.attempts,
      })
      atomicJson(join(store.directory(project.id), 'project.json'), project)
    } catch (error) {
      results.push({
        name: sample.name,
        passed: false,
        error: String(error),
        frames: entityFrames(project, source, from).length,
        attempts: project.identityResolution?.ai?.attempts,
      })
      // Do not generate repeated connectivity failures for the remaining cases.
      atomicJson(join(directory, 'results.json'), {
        source: 'real Qwen, controlled mentions',
        results,
        unrunCases: cases.slice(results.length).map((c) => c.name),
      })
      throw new Error(`真实AI验收未通过，记录：${directory}/results.json；${String(error)}`)
    }
  }
  atomicJson(join(directory, 'results.json'), { source: 'real Qwen, controlled mentions', results })
  if (results.some((r) => !(r as { passed: boolean }).passed))
    throw new Error(`真实AI语义验收失败：${directory}/results.json`)
  return directory
}
if (import.meta.main) console.log(await acceptEntityResolution())
