/**
 * 重放控制器测试：按回合节奏、快进、暂停/单步、缓存复用、复盘档案与赛后总结、
 * 以及与真实发布目录的隔离。
 *
 * 用真实 fixture 日志 + 脚本 provider（不联网），验证"每个友方回合都真正拿到
 * 建议"这一核心承诺——整份日志一次性灌入时只会剩下最后一个回合的建议。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardDatabase } from '../src/core/cards.ts'
import { createReplayController, formatProgress, ReplayController } from '../src/replay/controller.ts'
import type { ReplayEvent } from '../src/replay/controller.ts'
import { ReviewGenerator } from '../src/replay/review.ts'
import type { AdviceProvider } from '../src/runtime/engine.ts'
import type { Advice } from '../src/core/trigger.ts'

const db = new CardDatabase([join(import.meta.dirname, '..', 'data')])
const fixturePath = join(import.meta.dirname, 'fixtures', 'friendly_player_id_is_1.power.log')
const fixtureLines = (): string[] =>
  readFileSync(fixturePath, 'utf-8').split(/\r?\n/).filter(line => line.length > 0)

/** 记账用的脚本 provider：毫秒级返回，记录每个回合。 */
class ScriptedProvider implements AdviceProvider {
  calls: number[] = []
  async generate(input: Parameters<AdviceProvider['generate']>[0]): Promise<Advice> {
    this.calls.push(input.snapshot.turn)
    return {
      kind: 'play',
      headline: `T${input.snapshot.turn} 建议`,
      why: '测试理由',
      steps: ['一步'],
      warning: '',
      alternatives: [],
      latency_ms: 1,
      degraded: false,
      lethal: false,
    }
  }
}

const okReview = (): ReviewGenerator =>
  new ReviewGenerator({
    baseURL: 'http://mock',
    apiKey: 'k',
    model: 'm',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '# 复盘\n关键回合：T4。' } }] }),
    }),
  })

let dir: string
beforeEach(async () => {
  await db.build()
  dir = await mkdtemp(join(tmpdir(), 'hscoach-replay-ctl-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 轮询等待条件成立（测试内的时序同步）。 */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** 组装一个隔离的控制器（publish/cache/game 三个目录各自独立）。 */
function makeController(
  provider: AdviceProvider,
  options: { gameIndex?: number; review?: ReviewGenerator | null; cacheDir?: string; events?: ReplayEvent[] } = {},
): ReplayController {
  return new ReplayController({
    logPath: fixturePath,
    gameIndex: options.gameIndex ?? 0,
    publishDir: join(dir, 'replay-publish'),
    cacheDir: options.cacheDir ?? join(dir, 'cache'),
    gameDir: join(dir, 'game'),
    db,
    adviceProvider: provider,
    coachMode: 'teach',
    model: 'mock',
    reviewGenerator: options.review === undefined ? okReview() : options.review,
    minTurnIntervalMs: 0,
    onEvent: (event) => {
      options.events?.push(event)
    },
  })
}

describe('ReplayController', () => {
  it('按回合执教：每个友方回合都拿到建议，档案与总结落盘', async () => {
    const provider = new ScriptedProvider()
    const events: ReplayEvent[] = []
    const controller = makeController(provider, { events })

    const plan = await controller.load()
    expect(plan.gameCount).toBe(1)
    expect(plan.totalTurns).toBeGreaterThan(4)
    await controller.start()
    await controller.wait()

    const progress = controller.getProgress()
    expect(progress.phase).toBe('done')
    expect(progress.coached).toBeGreaterThan(1)
    expect(progress.skipped).toBe(0)

    const turns = controller.archivedTurns()
    expect(turns).toHaveLength(progress.coached)
    // 逐回合等待：模型调用次数 == 走模型的回合数（latest-wins 没有作废任何回合）
    const viaLlm = turns.filter(t => t.source === 'llm')
    expect(provider.calls).toHaveLength(viaLlm.length)
    expect(progress.llmCalls).toBe(viaLlm.length)
    expect(turns.every(t => t.source === 'llm' || t.source === 'rule')).toBe(true)
    const runInfo = controller.getRunInfo()
    expect(runInfo).not.toBeNull()
    const archive = await readFile(join(runInfo!.runDir, 'turns.jsonl'), 'utf-8')
    expect(archive.trim().split('\n')).toHaveLength(progress.coached)

    // 赛后总结：落盘 + 事件
    const review = await readFile(join(runInfo!.runDir, 'review.md'), 'utf-8')
    expect(review).toContain('关键回合：T4')
    expect(events.some(e => e.type === 'replay-review')).toBe(true)
    const done = events.find(e => e.type === 'replay-done')
    expect(done !== undefined && done.type === 'replay-done' && done.reviewPath !== null).toBe(true)

    // 来源统计与档案一致（llm + rule = 执教回合总数）
    const sources = controller.sources()
    expect(sources.llm).toBe(viaLlm.length)
    expect(sources.llm + sources.rule + sources.cache + sources.degraded + sources.unknown).toBe(
      progress.coached,
    )
  })

  it('第二次重放命中缓存：零模型调用、来源标 cache', async () => {
    const first = new ScriptedProvider()
    const firstController = makeController(first, { cacheDir: join(dir, 'shared-cache') })
    await firstController.start()
    await firstController.wait()
    expect(first.calls.length).toBeGreaterThan(1)

    const second = new ScriptedProvider()
    const secondController = makeController(second, { cacheDir: join(dir, 'shared-cache') })
    await secondController.start()
    await secondController.wait()

    expect(second.calls).toHaveLength(0)
    expect(secondController.getProgress().cacheHits).toBeGreaterThan(1)
    // 走模型的回合全部命中缓存；规则判定跳过的回合保持 rule（本来就不进缓存）
    expect(secondController.archivedTurns().every(t => t.source === 'cache' || t.source === 'rule')).toBe(true)
    expect(secondController.archivedTurns().filter(t => t.source === 'cache').length).toBe(
      secondController.getProgress().cacheHits,
    )
  })

  it('同局两轮重放：档案各自保留（不再互相覆盖），meta.json 落盘', async () => {
    const c1 = makeController(new ScriptedProvider())
    await c1.start()
    await c1.wait()
    const run1 = c1.getRunInfo()
    expect(run1).not.toBeNull()

    const c2 = makeController(new ScriptedProvider())
    await c2.start()
    await c2.wait()
    const run2 = c2.getRunInfo()

    expect(run2).not.toBeNull()
    expect(run2!.runId).not.toBe(run1!.runId)
    // 两轮的档案都还在：各自 turns.jsonl 行数等于各自执教回合数
    const a1 = await readFile(join(run1!.runDir, 'turns.jsonl'), 'utf-8')
    const a2 = await readFile(join(run2!.runDir, 'turns.jsonl'), 'utf-8')
    expect(a1.trim().split('\n')).toHaveLength(c1.getProgress().coached)
    expect(a2.trim().split('\n')).toHaveLength(c2.getProgress().coached)
    // meta.json 记录本轮的模式 / 模型 / 局序
    const meta = JSON.parse(await readFile(join(run2!.runDir, 'meta.json'), 'utf-8')) as Record<string, unknown>
    expect(meta).toMatchObject({ runId: run2!.runId, coachMode: 'teach', model: 'mock', gameIndex: 0 })
    // runs 目录下正好两个 run（按 runId 排序即时间序）
    const runs = await readdir(join(dir, 'game', 'runs'))
    expect(runs).toHaveLength(2)
  })

  it('快进：目标回合之前的批次不调用模型，之后恢复逐回合执教', async () => {
    const provider = new ScriptedProvider()
    const controller = makeController(provider)
    await controller.start(8)
    await controller.wait()

    const progress = controller.getProgress()
    expect(progress.skipped).toBeGreaterThan(0)
    expect(progress.coached).toBeGreaterThan(0)
    expect(provider.calls.every(turn => turn >= 8)).toBe(true)
    expect(provider.calls).toHaveLength(
      controller.archivedTurns().filter(t => t.source === 'llm').length,
    )
    // 跳过区间不归档（复盘档案只含真正执教过的回合）
    expect(controller.archivedTurns().every(t => t.turn >= 8)).toBe(true)
  })

  it('暂停/继续/单步：暂停后不再推进，单步正好走一个回合', async () => {
    const provider = new ScriptedProvider()
    const controller = makeController(provider)
    await controller.start()
    controller.pause()
    await waitFor(() => controller.getProgress().phase === 'paused')
    await new Promise(resolve => setTimeout(resolve, 80))
    const pausedAt = controller.getProgress().coached
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(controller.getProgress().coached).toBe(pausedAt)

    controller.step()
    await waitFor(() => controller.getProgress().phase === 'paused' && controller.getProgress().coached > pausedAt)
    const afterStep = controller.getProgress().coached
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(controller.getProgress().coached).toBe(afterStep)

    controller.resume()
    await controller.wait()
    expect(controller.getProgress().phase).toBe('done')
  })

  it('停止：保留档案、phase=stopped、不生成总结', async () => {
    const provider = new ScriptedProvider()
    const events: ReplayEvent[] = []
    const controller = makeController(provider, { events })
    await controller.start()
    await controller.stop()
    expect(controller.getProgress().phase).toBe('stopped')
    const done = events.find(e => e.type === 'replay-done')
    expect(done !== undefined && done.type === 'replay-done' && done.reviewPath === null).toBe(true)
  })

  it('不存在的对局序号：load 抛错并指出共几局', async () => {
    const controller = makeController(new ScriptedProvider(), { gameIndex: 3 })
    await expect(controller.load()).rejects.toThrow(/没有第 4 局（共 1 局）/)
  })

  it('未配置总结生成器：跳过并上报原因', async () => {
    const events: ReplayEvent[] = []
    const controller = makeController(new ScriptedProvider(), { review: null, events })
    await controller.start()
    await controller.wait()
    expect(controller.getProgress().phase).toBe('done')
    const skipped = events.find(e => e.type === 'replay-review-skipped')
    expect(skipped !== undefined && skipped.type === 'replay-review-skipped').toBe(true)
  })

  it('总结生成失败不影响重放结论', async () => {
    const events: ReplayEvent[] = []
    const failing = new ReviewGenerator({
      baseURL: 'http://mock',
      apiKey: 'k',
      model: 'm',
      fetchImpl: (async () => ({ ok: false, status: 503, statusText: 'down' })) as unknown as typeof fetch,
    })
    const controller = makeController(new ScriptedProvider(), { review: failing, events })
    await controller.start()
    await controller.wait()
    expect(controller.getProgress().phase).toBe('done')
    const skipped = events.find(e => e.type === 'replay-review-skipped')
    expect(skipped !== undefined && skipped.type === 'replay-review-skipped' && /503/.test(skipped.reason)).toBe(true)
  })

  it('工厂装配：可复用卡牌库，也可自行构建；进度文案可用', async () => {
    const withDb = await createReplayController({
      logPath: fixturePath,
      gameIndex: 0,
      publishDir: join(dir, 'factory-publish'),
      cacheDir: join(dir, 'factory-cache'),
      gameDir: join(dir, 'factory-game'),
      baseURL: 'http://mock',
      apiKey: '',
      model: 'mock',
      coachMode: 'teach',
      db,
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({}) })) as unknown as typeof fetch,
      minTurnIntervalMs: 0,
    })
    const plan = await withDb.load()
    expect(plan.segmentsTotal).toBeGreaterThan(1)
    expect(formatProgress(withDb.getProgress())).toContain('第 1 局')
    expect(formatProgress(withDb.getProgress())).toContain('执教 0')

    const selfBuilt = await createReplayController({
      logPath: fixturePath,
      gameIndex: 0,
      publishDir: join(dir, 'factory-publish2'),
      cacheDir: join(dir, 'factory-cache2'),
      gameDir: join(dir, 'factory-game2'),
      baseURL: 'http://mock',
      apiKey: 'k',
      model: 'mock',
      coachMode: 'teach',
      cardDataDir: join(import.meta.dirname, '..', 'data'),
      minTurnIntervalMs: 0,
    })
    expect(await selfBuilt.load()).toBeTruthy()
  })

  it('日志行本身不被改写（重放只读）', async () => {
    const before = fixtureLines().length
    const controller = makeController(new ScriptedProvider())
    await controller.start(6)
    await controller.wait()
    expect(fixtureLines()).toHaveLength(before)
  })
})
