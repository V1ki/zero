import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@zero-os/core'
import {
  AnthropicModelsDiscoveryDriver,
  ChatGptCodexDiscoveryDriver,
  ModelCatalogCoordinator,
  ModelCatalogStore,
  ModelRouter,
} from '@zero-os/model'
import { RouterLedgerStore } from '@zero-os/observe'
import { OutputSecretFilter, loadVault } from '@zero-os/secrets'
import type { RouterJobReceipt } from '@zero-os/shared'
import { type RouterAgentInput, createRouterAgent } from '../router-agent'
import { capability } from '../router-capabilities'
import { matterCapabilities } from '../router-matter-capabilities'
import { RouterPublications } from '../router-publications'
import { createRouterTraceSink } from '../router-trace'

// Opt-in real model evaluation. All matters and external effects are isolated;
// only the configured model credentials are read from the selected data directory.
const live = process.env.ZERO_ROUTER_PREPARATION_LIVE === '1'
test.skipIf(!live)(
  'prepares concrete decisions, resumes the accepted scope, and honors review-only work',
  async () => {
    const output = process.env.ZERO_ACCEPTANCE_OUTPUT
    if (!output) throw Error('Set ZERO_ACCEPTANCE_OUTPUT to an isolated directory')
    mkdirSync(output, { recursive: true })
    const dataDir = process.env.ZERO_ACCEPTANCE_DATA_DIR ?? join(process.cwd(), '.zero')
    const vault = await loadVault(join(dataDir, 'secrets.enc'))
    const filter = new OutputSecretFilter(vault.entries())
    const config = loadConfig(join(dataDir, 'config.yaml'))
    copyFileSync(join(dataDir, 'cache/model-catalog/catalog.json'), join(output, 'catalog.json'))
    const catalog = new ModelCatalogCoordinator({
      config,
      secretGetter: (ref) => vault.get(ref) ?? undefined,
      store: new ModelCatalogStore(join(output, 'catalog.json')),
      drivers: [new ChatGptCodexDiscoveryDriver(), new AnthropicModelsDiscoveryDriver()],
    })
    await catalog.initialize()
    const router = new ModelRouter(config, new Map(vault.entries()), {
      secretGetter: (ref) => vault.get(ref) ?? undefined,
      catalog,
    })
    const initialized = router.init()
    if (!initialized.success) throw Error(initialized.message)
    const db = new Database(join(output, 'preparation.sqlite'))
    const store = new RouterLedgerStore(db)
    const ask = createRouterAgent({
      secretFilter: filter,
      modelRouter: {
        getDefaultModel: () => router.getDefaultModel(),
        getCurrentModel: () => router.getCurrentModel(),
        trace: createRouterTraceSink(store, (text) => filter.filter(text)),
      },
    })
    const base: RouterAgentInput = {
      sessionId: 'preparation-live',
      question: '',
      history: [],
      event: null,
      route: null,
      subscriptions: { github: 1, wxarc: 0 },
      settings: {
        enabled: true,
        timeZone: 'Asia/Shanghai',
        workdays: [1, 2, 3, 4, 5],
        workStart: '09:00',
        workEnd: '18:00',
        presence: 'auto',
        duringWork: 'web',
        afterWork: 'defer',
        offDay: 'defer',
        awayFallback: 'defer',
        weixinTarget: null,
      },
    }
    const calls: Array<{ jobId: number; instruction?: string }> = []
    const publications: unknown[] = []
    let externalWrites = 0
    const receipt = (id: number, result?: string): RouterJobReceipt => ({
      id,
      executor: 'codex',
      repository: 'fixture/project',
      attempt: result ? 1 : 2,
      status: result ? 'completed' : 'queued',
      result,
    })
    const facts =
      'PR #12 head abc123；当前无评论。已用真实转换器验证 src/ids.ts:10 将 call.a 与 call:a 同时转为 call_a，调用与结果失去唯一对应。需要稳定防碰撞映射，补非法 ID 互撞、合法 ID 占位和逆序结果回归。未调用服务端。审查建议暂缓合并。'
    const actions: RouterAgentInput['actions'] = {
      capabilities: [
        ...matterCapabilities(store, 'owner', () => true),
        capability(
          'publish_update',
          '保存给本人的进展或具体决定。',
          {
            matterId: { type: 'string' },
            version: { type: 'integer' },
            presentations: { type: 'object' },
          },
          (input) => {
            publications.push(input)
            return { status: 'accepted' }
          },
        ),
        capability(
          'post_comment',
          '向 PR 作者发布评论，必须已有本事项的发送授权。',
          {
            number: { type: 'integer' },
            body: { type: 'string' },
          },
          () => {
            externalWrites++
            throw Error('External writes forbidden in this evaluation')
          },
        ),
      ],
      getTaskStatus: async (id) =>
        receipt(
          id,
          id === 13
            ? 'PR #13 head def456，src/cache.ts:20 撤销别名后仍返回缓存别名，已核对当前无评论。请缓存原始名称并补设置撤销回归。'
            : id === 14
              ? 'PR #14 已核查，发现 src/name.ts:3 的名称覆盖错误，建议暂缓，测试已通过。'
              : facts,
        ),
      continueTask: async (id, _signal, instruction) => {
        calls.push({ jobId: id, instruction })
        return receipt(id)
      },
    }
    try {
      if (process.env.ZERO_ROUTER_CARDS_ONLY !== '1') {
        const matter = store.createMatter(
          'owner',
          'PR #12 新线索',
          '核验新 PR 的问题并准备有用的后续处理',
          ['核验问题并交付可执行成果'],
        )
        store.updateMatter('owner', matter.id, matter.version, {
          state: 'working',
          context: {
            worker: { jobId: 12 },
            source: { head: 'abc123' },
            authorization: '仅核查和准备，未授权对外评论或合并。',
          },
        })
        const prepared = store.createMatter('owner', 'PR #13 待反馈', '准备 PR #13 缺陷反馈', [
          '交付具体反馈正文',
        ])
        store.updateMatter('owner', prepared.id, prepared.version, {
          state: 'waiting',
          context: {
            worker: { jobId: 13 },
            head: 'def456',
            decision: '是否发布本条反馈',
            draft: 'src/cache.ts:20 撤销别名后仍返回缓存别名。请缓存原始名称并补设置撤销回归。',
            authorization: '未授权发布；已核对版本及评论，缺陷仍成立且无重复反馈。',
          },
        })
        const first = await ask({
          ...base,
          actions,
          signalContext: { kind: 'worker_result', payload: { jobId: 12, attempt: 1 } },
          question: `Worker #12 返回：${facts}`,
          matterContext: {
            focusedMatter: store.getMatter('owner', matter.id),
            matters: [store.getMatter('owner', prepared.id)],
          },
        })
        writeFileSync(
          join(output, 'prepared.json'),
          JSON.stringify(
            { answer: first, calls, publications, matters: store.searchMatters('owner', '') },
            null,
            2,
          ),
        )
        expect(externalWrites).toBe(0)
        expect(store.getMatter('owner', matter.id)?.state).not.toBe('completed')
        const preparedText = JSON.stringify({
          answer: first,
          publications,
          context: store.getMatter('owner', matter.id)?.context,
        })
        expect(preparedText).toContain('call.a')
        expect(preparedText).toContain('call:a')
        expect(preparedText).toContain('13')
        expect(preparedText).toContain('src/cache.ts')

        calls.length = 0
        const accepted = await ask({
          ...base,
          actions,
          question: '发布刚才 #12 和 #13 这两条反馈，并跟进作者修订；不要合并。',
          signalContext: { kind: 'user' },
          matterContext: {
            matters: [store.getMatter('owner', matter.id), store.getMatter('owner', prepared.id)],
          },
        })
        writeFileSync(
          join(output, 'accepted.json'),
          JSON.stringify({ answer: accepted, calls }, null, 2),
        )
        expect(calls.map((c) => c.jobId).sort()).toEqual([12, 13])
        expect(externalWrites).toBe(0)

        calls.length = 0
        const current = store.getMatter('owner', matter.id)
        if (!current) throw Error('Missing test matter')
        store.updateMatter('owner', matter.id, current.version, {
          state: 'waiting',
          context: {
            ...current.context,
            worker: { jobId: 12, attempt: 2, status: 'completed' },
            authorization: '用户已要求发布 #12 的具体反馈并跟进作者修订，不合并。',
            receipt: {
              url: 'https://github.com/fixture/project/pull/12#issuecomment-1',
              status: 'sent',
            },
            next: '等待作者提交修订，沿用 Worker #12 核验。',
          },
        })
        const resumed = await ask({
          ...base,
          actions,
          signalContext: { kind: 'event', payload: { number: 12, head: 'abc789' } },
          question: '已核验的新提交事件：PR #12 从 abc123 更新到 abc789，作者称已修复 ID 碰撞。',
          matterContext: { focusedMatter: store.getMatter('owner', matter.id) },
        })
        writeFileSync(
          join(output, 'resumed.json'),
          JSON.stringify({ answer: resumed, calls }, null, 2),
        )
        expect(calls.map((c) => c.jobId)).toEqual([12])
        expect(externalWrites).toBe(0)

        calls.length = 0
        const review = store.createMatter(
          'owner',
          '仅审查 #14',
          '只审查 PR #14 并报告，不准备评论或跟进',
          ['提交审查结论'],
        )
        const reviewed = await ask({
          ...base,
          actions,
          question:
            'Worker #14 完成：PR #14 已核查，发现 src/name.ts:3 的名称覆盖错误，建议暂缓，测试已通过。',
          signalContext: { kind: 'worker_result', payload: { jobId: 14, attempt: 1 } },
          matterContext: { focusedMatter: review },
        })
        writeFileSync(
          join(output, 'review-only.json'),
          JSON.stringify(
            { answer: reviewed, calls, matter: store.getMatter('owner', review.id) },
            null,
            2,
          ),
        )
        // A terse review may legitimately need more evidence. Continuing that
        // review is allowed; preparing comments or following revisions is not.
        for (const call of calls) {
          expect(call.jobId).toBe(14)
          expect(call.instruction).toMatch(/(?:仅|只|限于).{0,15}审查/)
          expect(call.instruction).toMatch(/(?:不要|不|禁止).{0,25}评论/)
          expect(call.instruction).toMatch(/(?:不要|不|禁止).{0,25}跟进/)
        }
        expect(externalWrites).toBe(0)
        if (calls.length) expect(store.getMatter('owner', review.id)?.state).not.toBe('completed')
        else expect(store.getMatter('owner', review.id)?.state).toBe('completed')
      }

      const decision = store.createMatter(
        'router-owner',
        'PR #16 待发布反馈',
        '准备具体反馈供用户决定',
        ['确认后才能向作者发布，不合并'],
      )
      store.updateMatter('router-owner', decision.id, decision.version, {
        state: 'waiting',
        context: {
          head: 'ghi789',
          draft: 'src/cache.ts:20 撤销别名后仍返回缓存别名。请缓存原始名称并补设置撤销回归。',
          evidence: '版本已核对，问题仍成立且无重复反馈，完整正文已备好。',
          next: '等待用户决定是否发布这条具体反馈，不包含合并。',
        },
      })
      publications.length = 0
      const cardPublications = new RouterPublications(store, {
        getConfig: () => ({
          revision: 1,
          settings: {
            ...base.settings,
            personalBots: { feishu: 'fixture-feishu', dingtalk: 'fixture-dingtalk' },
          },
        }),
        listPersonalBots: () => [],
        prepareDirectReminder: (platform) => ({
          channelId: `fixture-${platform}`,
          audienceKey: 'fixture-owner',
          label: platform,
        }),
        sendDirectReminder: async (
          platform,
          _prepared,
          _text,
          deliveryId,
          _signal,
          maySend,
          presentation,
        ) => {
          if (!maySend?.()) throw Error('Revoked fixture delivery')
          publications.push({ presentations: { [platform]: presentation } })
          return { status: 'accepted', receipt: deliveryId }
        },
      })
      const cards = await ask({
        ...base,
        settings: {
          ...base.settings,
          personalBots: { feishu: 'fixture-feishu', dingtalk: 'fixture-dingtalk' },
        },
        actions: {
          capabilities: [
            ...matterCapabilities(store, 'router-owner', () => true),
            ...cardPublications.capabilities('router-owner', 'general', 16, () => true),
          ],
        },
        question: '把 PR #16 这条准备好的反馈交付给我决定，本次仅飞书和钉钉。',
        signalContext: { kind: 'user' },
        matterContext: { focusedMatter: store.getMatter('router-owner', decision.id) },
      })
      writeFileSync(
        join(output, 'decision-cards.json'),
        JSON.stringify({ answer: cards, publications }, null, 2),
      )
      const presentations = publications.flatMap((p) => {
        const publication = p as {
          presentations: Record<
            string,
            { text: string; actions: Array<{ id: string; label: string }> }
          >
        }
        return Object.entries(publication.presentations)
      })
      const feishu = presentations.find(([platform]) => platform === 'feishu')?.[1]
      const dingtalk = presentations.find(([platform]) => platform === 'dingtalk')?.[1]
      expect(feishu?.actions.length).toBeGreaterThan(0)
      expect(dingtalk?.actions).toHaveLength(1)
      expect(dingtalk?.actions[0].label).toBe('确认')
      expect(dingtalk?.text).toContain('确认')
      expect(dingtalk?.text).toContain('16')
      expect(externalWrites).toBe(0)
    } finally {
      db.close()
    }
  },
  420_000,
)
