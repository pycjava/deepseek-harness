/**
 * 重放控制器：把一份历史 Power.log 按回合喂回教练管线。
 *
 * 与实时监听的关系：**并存但完全隔离**。控制器自建一个 CoachEngine，发布目录
 * 指向重放目录（advice.json / game_state.json / history.jsonl / stats.json 全部
 * 落在那里），因此重放永远不会污染悬浮窗读的那份真实契约，也不会往真实战绩
 * 里记假账（引擎的终局记录不区分真假对局，隔离只能靠目录）。
 *
 * 节奏：按回合批次喂入，每批 `await idle()` 等建议落定再进下一批——这样
 * latest-wins 不会作废中间回合（整份日志一次性灌入时，一局只会剩下最后一个
 * 回合的建议）。快进区间不等待、不调用模型，用规则占位建议；琐碎回合
 * （确实无动作可做）同样跳过模型。每轮重放的档案独立存档（`runs/<runId>/`：
 * turns.jsonl + review.md + meta.json），同局换模式重跑不会覆盖上一轮，
 * 历史轮次可随时回看（bin 层的 /api/replay/runs）。
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CardDatabase } from '../core/cards.ts'
import { defaultDataDirs } from '../core/cards.ts'
import { CardDatabase as CardDatabaseCtor } from '../core/cards.ts'
import { ADVICE_FILENAME, type Advice } from '../core/trigger.ts'
import { DirectApiAdviceProvider } from '../advice/directProvider.ts'
import { CoachEngine, type AdviceProvider, type EngineEvent } from '../runtime/engine.ts'
import { AdviceCache, adviceCacheKey } from './cache.ts'
import { fastForwardAdvice, isTrivialTurn, trivialAdvice } from './trivial.ts'
import { planReplay, type ReplayGamePlan } from './splitter.ts'
import { ReviewGenerator, type ReviewInput, type ReviewTurn } from './review.ts'

/** 重放阶段。 */
export type ReplayPhase = 'idle' | 'running' | 'paused' | 'done' | 'stopped' | 'error'

/** 重放进度（页面轮询展示）。 */
export interface ReplayProgress {
  phase: ReplayPhase
  /** 正在重放的对局序号（0 基）。 */
  gameIndex: number
  /** 已喂到的回合号。 */
  turn: number
  /** 该局计划的最大回合号。 */
  totalTurns: number
  /** 已处理的批次数 / 总批次。 */
  segmentsDone: number
  segmentsTotal: number
  /** 真正产出建议的回合数（模型 / 缓存 / 规则判定）。 */
  coached: number
  /** 快进跳过的回合数。 */
  skipped: number
  /** 命中缓存的回合数。 */
  cacheHits: number
  /** 真实模型调用次数。 */
  llmCalls: number
  /** 规则判定跳过的回合数。 */
  ruleTurns: number
  /** 人类可读的状态说明。 */
  message: string
}

/** 重放事件（进度、总结、错误）。 */
export type ReplayEvent =
  | { type: 'replay-progress'; progress: ReplayProgress }
  | { type: 'replay-review'; path: string }
  | { type: 'replay-review-skipped'; reason: string }
  | { type: 'replay-done'; progress: ReplayProgress; reviewPath: string | null }
  | { type: 'replay-error'; reason: string }

/** 建议来源（复盘档案里逐条标注）。 */
export type AdviceSource = 'llm' | 'cache' | 'rule' | 'skip' | 'degraded' | 'unknown'

/** 重放控制器构造参数。 */
export interface ReplayControllerOptions {
  /** 待重放的日志绝对路径。 */
  logPath: string
  /** 重放第几局（0 基，对应 CREATE_GAME 顺序）。 */
  gameIndex: number
  /** 重放发布目录（必须与真实发布目录不同）。 */
  publishDir: string
  /** 建议缓存目录。 */
  cacheDir: string
  /** 复盘档案目录（turns.jsonl / review.md）。 */
  gameDir: string
  /** 卡牌库（只读复用）。 */
  db: CardDatabase
  /** 真实模型 provider（缓存与规则层包在其外层）。 */
  adviceProvider: AdviceProvider
  /** 教练模式。 */
  coachMode: string
  /** 模型名（缓存键与复盘元信息）。 */
  model: string
  /** 固定友方玩家 id；null = 由日志自动校准。 */
  friendlyPlayerId?: number | null | undefined
  /** 赛后总结生成器；缺席则不做总结。 */
  reviewGenerator?: ReviewGenerator | null | undefined
  /** 复盘档案路径；默认 `<gameDir>/runs/<runId>/review.md`。 */
  reviewPath?: string | undefined
  /** 事件回调。 */
  onEvent?: ((event: ReplayEvent) => void) | undefined
  /** 执教回合之间的最小间隔（毫秒），默认 500；测试用 0 提速。 */
  minTurnIntervalMs?: number | undefined
}

/** 每个执教回合之间的最小间隔（毫秒）：让局面快照与页面有可观察的节拍。 */
const MIN_TURN_INTERVAL_MS = 500

/** 引擎局面快照节流：略小于回合间隔，保证每个执教回合都发布一次快照。 */
const REPLAY_STATE_THROTTLE_MS = 400

/** 读 JSON 文件；缺失/损坏返回 null。 */
async function readJsonOrNull(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as unknown
  } catch {
    return null
  }
}

/** 建议 provider 装饰器：快进跳过 + 琐碎回合规则 + 磁盘缓存 + 来源记账。 */
class ReplayAdviceProvider implements AdviceProvider {
  /** 快进区间：true 时不调用模型，直接返回占位建议。 */
  skipping = false
  private readonly sources = new Map<number, AdviceSource>()
  private llmCallCount = 0
  private ruleTurnCount = 0

  constructor(
    private readonly deps: {
      base: AdviceProvider
      cache: AdviceCache
      model: string
      coachMode: string
    },
  ) {}

  /** 某回合建议的来源（未生成过返回 undefined）。 */
  sourceOf(turn: number): AdviceSource | undefined {
    return this.sources.get(turn)
  }

  /** 真实模型调用次数（缓存命中与规则跳过不计）。 */
  get llmCalls(): number {
    return this.llmCallCount
  }

  /** 规则判定跳过的回合数。 */
  get ruleTurns(): number {
    return this.ruleTurnCount
  }

  /**
   * 生成建议：快进 → 规则 → 缓存 → 模型。
   * @param input - 引擎传入的局面与生成参数。
   * @returns 建议（契约字段完整）。
   */
  async generate(input: Parameters<AdviceProvider['generate']>[0]): Promise<Advice> {
    const turn = input.snapshot.turn
    if (this.skipping) {
      this.sources.set(turn, 'skip')
      return fastForwardAdvice(turn)
    }
    if (isTrivialTurn(input.snapshot, input.friendlyPlayerId, input.lethal)) {
      this.ruleTurnCount += 1
      this.sources.set(turn, 'rule')
      return trivialAdvice(turn)
    }
    const key = adviceCacheKey({
      model: this.deps.model,
      coachMode: this.deps.coachMode,
      snapshot: input.snapshot,
    })
    const cached = await this.deps.cache.get(key)
    if (cached !== null) {
      this.sources.set(turn, 'cache')
      return cached
    }
    const advice = await this.deps.base.generate(input)
    this.llmCallCount += 1
    this.sources.set(turn, 'llm')
    await this.deps.cache.put(key, { model: this.deps.model, coachMode: this.deps.coachMode, turn }, advice)
    return advice
  }
}

/** 本轮重放存档信息（runId / 目录）。 */
export interface ReplayRunInfo {
  runId: string
  runDir: string
}

/** 生成 runId：本地时间戳 + 教练模式；同秒冲突时追加 -2/-3 序号。 */
function makeRunId(gameDir: string, coachMode: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const base = `${stamp}__${coachMode}`
  let candidate = base
  for (let n = 2; existsSync(join(gameDir, 'runs', candidate)); n += 1) {
    candidate = `${base}-${n}`
  }
  return candidate
}

/** 一局历史对局的按回合重放控制器。 */
export class ReplayController {
  private readonly engine: CoachEngine
  private readonly provider: ReplayAdviceProvider
  private readonly cache: AdviceCache
  private readonly options: ReplayControllerOptions
  private plans: ReplayGamePlan[] = []
  private plan: ReplayGamePlan | null = null
  private readonly advicePath: string
  /** 以下两个路径在 start() 建立本轮 run 目录后指向 runs/<runId>/ 下。 */
  private turnsPath = ''
  private reviewPath = ''
  private runInfo: ReplayRunInfo | null = null

  private phase: ReplayPhase = 'idle'
  private paused = false
  /** 单步目标：coached 达到该值即暂停（null = 无单步在手）。 */
  private stepTarget: number | null = null
  private stopped = false
  private targetTurn = 0
  private gate: { promise: Promise<void>; resolve: () => void } | null = null
  private runPromise: Promise<void> | null = null
  private result = 'unknown'
  private archived: ReviewTurn[] = []
  private progress: ReplayProgress = {
    phase: 'idle',
    gameIndex: 0,
    turn: 0,
    totalTurns: 0,
    segmentsDone: 0,
    segmentsTotal: 0,
    coached: 0,
    skipped: 0,
    cacheHits: 0,
    llmCalls: 0,
    ruleTurns: 0,
    message: '未开始',
  }

  /**
   * @param options - 日志、隔离目录、卡牌库与模型 provider。
   */
  constructor(options: ReplayControllerOptions) {
    this.options = options
    this.cache = new AdviceCache(options.cacheDir)
    this.provider = new ReplayAdviceProvider({
      base: options.adviceProvider,
      cache: this.cache,
      model: options.model,
      coachMode: options.coachMode,
    })
    this.advicePath = join(options.publishDir, ADVICE_FILENAME)
    this.engine = new CoachEngine({
      publishDir: options.publishDir,
      db: options.db,
      adviceProvider: this.provider,
      friendlyPlayerId: options.friendlyPlayerId ?? null,
      coachMode: options.coachMode,
      stateThrottleMs: REPLAY_STATE_THROTTLE_MS,
      onEvent: (event) => {
        this.handleEngineEvent(event)
      },
    })
    this.progress.gameIndex = options.gameIndex
  }

  /**
   * 本轮重放的存档信息（runs/<runId>/）；未 start 时为 null。
   * @returns runId 与 runDir 的副本。
   */
  getRunInfo(): ReplayRunInfo | null {
    return this.runInfo === null ? null : { ...this.runInfo }
  }

  /** 当前进度快照（副本）。 */
  getProgress(): ReplayProgress {
    return {
      ...this.progress,
      cacheHits: this.cache.hitCount,
      llmCalls: this.provider.llmCalls,
      ruleTurns: this.provider.ruleTurns,
    }
  }

  /**
   * 装载日志并切批（幂等）。
   * @returns 该日志的对局数与选中局的总回合数。
   * @throws 日志中不存在该局序号时抛错。
   */
  async load(): Promise<{ gameCount: number; totalTurns: number; segmentsTotal: number }> {
    if (this.plan !== null) {
      return {
        gameCount: this.plans.length,
        totalTurns: this.progress.totalTurns,
        segmentsTotal: this.progress.segmentsTotal,
      }
    }
    const text = await readFile(this.options.logPath, 'utf-8')
    this.plans = planReplay(text.split(/\r?\n/))
    const plan = this.plans[this.options.gameIndex]
    if (plan === undefined) {
      throw new Error(
        `日志里没有第 ${this.options.gameIndex + 1} 局（共 ${this.plans.length} 局）：${this.options.logPath}`,
      )
    }
    this.plan = plan
    this.progress.totalTurns = plan.segments.reduce((max, segment) => Math.max(max, segment.turn), 0)
    this.progress.segmentsTotal = plan.segmentCount
    return {
      gameCount: this.plans.length,
      totalTurns: this.progress.totalTurns,
      segmentsTotal: plan.segmentCount,
    }
  }

  /**
   * 开始重放（后台运行，立即返回）。
   *
   * 每轮重放建立独立存档目录 `runs/<runId>/`（turns.jsonl + review.md +
   * meta.json）：同局换模式/重跑都不会覆盖上一轮，历史轮次永久保留。
   * （建议缓存目录不受影响，缓存始终跨轮次复用。）
   * @param targetTurn - 快进目标回合（>0 时，该回合之前的批次不调用模型）。
   */
  async start(targetTurn = 0): Promise<void> {
    if (this.phase === 'running' || this.phase === 'paused') return
    await this.load()
    await mkdir(this.options.publishDir, { recursive: true })
    const runId = makeRunId(this.options.gameDir, this.options.coachMode)
    const runDir = join(this.options.gameDir, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    this.runInfo = { runId, runDir }
    this.turnsPath = join(runDir, 'turns.jsonl')
    this.reviewPath = this.options.reviewPath ?? join(runDir, 'review.md')
    await writeFile(this.turnsPath, '', 'utf-8')
    await writeFile(
      join(runDir, 'meta.json'),
      `${JSON.stringify({
        runId,
        startedAt: new Date().toISOString(),
        coachMode: this.options.coachMode,
        model: this.options.model,
        gameIndex: this.options.gameIndex,
        logPath: this.options.logPath,
      }, null, 2)}\n`,
      'utf-8',
    )
    this.targetTurn = targetTurn > 0 ? targetTurn : 0
    this.stopped = false
    this.paused = false
    this.stepTarget = null
    this.phase = 'running'
    this.progress.message = this.targetTurn > 0 ? `快进至 T${this.targetTurn} 后开始执教` : '逐回合执教中'
    this.emitProgress()
    this.runPromise = this.run()
  }

  /** 暂停（当前回合生成完建议后停在下一批之前）。 */
  pause(): void {
    if (this.phase !== 'running') return
    this.paused = true
    this.phase = 'paused'
    this.progress.message = '已暂停'
    this.emitProgress()
  }

  /** 继续。 */
  resume(): void {
    if (this.phase !== 'paused' && this.phase !== 'running') return
    this.paused = false
    this.stepTarget = null
    this.phase = 'running'
    this.releaseGate()
    this.progress.message = '逐回合执教中'
    this.emitProgress()
  }

  /** 单步：走到下一个产出建议的回合（跳过对手回合）后自动暂停。 */
  step(): void {
    if (this.phase !== 'running' && this.phase !== 'paused') return
    this.stepTarget = this.progress.coached + 1
    this.paused = false
    this.phase = 'running'
    this.releaseGate()
    this.progress.message = '单步：走到下一个建议'
    this.emitProgress()
  }

  /**
   * 快进：跳过当前回合到 `turn` 之前的批次（不调用模型），随后恢复逐回合执教。
   * @param turn - 目标回合号。
   */
  fastForwardTo(turn: number): void {
    this.targetTurn = Math.max(turn, this.progress.turn + 1)
    this.paused = false
    this.stepTarget = null
    this.releaseGate()
    this.progress.message = `快进至 T${this.targetTurn}`
    this.emitProgress()
  }

  /** 停止重放（等待在途建议落定）。 */
  async stop(): Promise<void> {
    if (this.phase === 'done' || this.phase === 'stopped' || this.phase === 'error') return
    this.stopped = true
    this.releaseGate()
    await this.runPromise
  }

  /** 等待整局重放结束（测试与优雅退出用）。 */
  async wait(): Promise<void> {
    await this.runPromise
  }

  /** 各回合建议来源统计（档案展示）。 */
  sources(): Record<AdviceSource, number> {
    const counts: Record<string, number> = {
      llm: 0, cache: 0, rule: 0, skip: 0, degraded: 0, unknown: 0,
    }
    for (const turn of this.archived) {
      counts[turn.source] = (counts[turn.source] ?? 0) + 1
    }
    return counts
  }

  /** 已归档的逐回合建议（复盘视图用）。 */
  archivedTurns(): ReviewTurn[] {
    return [...this.archived]
  }

  // ── 内部 ────────────────────────────────────────────────

  private handleEngineEvent(event: EngineEvent): void {
    if (event.type === 'game-result') this.result = event.result
  }

  /**
   * 是否已请求停止。经方法读取，避免 TS 把 `this.stopped` 收窄成常量
   * （stop() 会在 await 之间把它置真）。
   * @returns 已请求停止返回 true。
   */
  private isStopped(): boolean {
    return this.stopped
  }

  private emit(event: ReplayEvent): void {
    this.options.onEvent?.(event)
  }

  private emitProgress(): void {
    this.progress.phase = this.phase
    this.emit({ type: 'replay-progress', progress: this.getProgress() })
  }

  private async waitGate(): Promise<void> {
    while (this.paused && !this.stopped) {
      if (this.stepTarget !== null) return
      if (this.gate === null) {
        let resolve: () => void = () => {}
        const promise = new Promise<void>((r) => {
          resolve = r
        })
        this.gate = { promise, resolve }
      }
      await this.gate.promise
    }
  }

  private releaseGate(): void {
    const gate = this.gate
    this.gate = null
    gate?.resolve()
  }

  /** 主循环：逐批喂入 → 等建议落定 → 归档 → 下一个回合。 */
  private async run(): Promise<void> {
    const plan = this.plan
    /* v8 ignore next -- start 先 load，plan 必已就位 */
    if (plan === null) return
    try {
      for (const segment of plan.segments) {
        if (this.isStopped()) break
        await this.waitGate()
        if (this.isStopped()) break
        const skip = this.targetTurn > 0 && segment.turn < this.targetTurn
        this.provider.skipping = skip
        const startedAt = Date.now()
        await this.engine.processLines(segment.lines)
        if (skip) {
          this.progress.skipped += 1
        } else {
          // 本回合建议必须落定后再进下一回合，否则 latest-wins 会作废它
          await this.engine.idle()
          // 只有真正产出建议的回合（友方回合）才计入执教与档案
          const archived = await this.archiveTurn(segment.turn)
          if (archived) this.progress.coached += 1
          await this.pace(startedAt)
        }
        this.progress.turn = Math.max(this.progress.turn, segment.turn)
        this.progress.segmentsDone += 1
        if (this.targetTurn > 0 && this.progress.turn >= this.targetTurn) {
          this.progress.message = '已到目标回合，逐回合执教中'
        }
        if (this.stepTarget !== null && this.progress.coached >= this.stepTarget) {
          this.stepTarget = null
          this.paused = true
          this.phase = 'paused'
          this.progress.message = '单步完成，已暂停'
        }
        this.emitProgress()
      }
      this.provider.skipping = false
      if (!this.stopped) await this.engine.idle()
      const reviewPath = this.stopped ? null : await this.finishReview()
      this.phase = this.stopped ? 'stopped' : 'done'
      this.progress.message = this.stopped ? '已停止（档案已保留）' : '重放完成'
      this.emitProgress()
      this.emit({ type: 'replay-done', progress: this.getProgress(), reviewPath })
    } catch (error) {
      this.phase = 'error'
      const reason = error instanceof Error ? error.message : String(error)
      this.progress.message = `重放失败：${reason}`
      this.emitProgress()
      this.emit({ type: 'replay-error', reason })
    }
  }

  /** 保证执教回合之间有最小节拍（局面快照与页面可观察）。 */
  private async pace(startedAt: number): Promise<void> {
    const interval = this.options.minTurnIntervalMs ?? MIN_TURN_INTERVAL_MS
    if (interval <= 0) return
    const elapsed = Date.now() - startedAt
    if (elapsed >= interval) return
    await new Promise(resolve => setTimeout(resolve, interval - elapsed))
  }

  /**
   * 归档本回合发布出去的建议（以 advice.json 为准，含引擎降级回退）。
   * @param segmentTurn - 本批次起始回合号。
   * @returns 归档了建议返回 true；对手回合（未发布新建议）返回 false。
   */
  private async archiveTurn(segmentTurn: number): Promise<boolean> {
    const doc = (await readJsonOrNull(this.advicePath)) as
      | { turn?: unknown; timestamp?: unknown; advice?: unknown }
      | null
    if (doc === null) return false
    // 非友方回合不会发布新建议：此时 advice.json 仍是上一回合的，跳过避免重复归档
    if (doc.turn !== segmentTurn) return false
    const advice = doc.advice
    /* v8 ignore next -- 发布契约保证 advice 字段存在 */
    if (advice === null || typeof advice !== 'object') return false
    const body = advice as Advice
    const source = this.provider.sourceOf(segmentTurn) ?? (body.degraded ? 'degraded' : 'unknown')
    const entry = {
      turn: segmentTurn,
      timestamp: typeof doc.timestamp === 'string' ? doc.timestamp : null,
      source,
      advice: body,
    }
    await appendFile(this.turnsPath, `${JSON.stringify(entry)}\n`, 'utf-8')
    this.archived.push({
      turn: segmentTurn,
      kind: body.kind,
      headline: body.headline,
      why: body.why,
      steps: Array.isArray(body.steps) ? body.steps : [],
      warning: body.warning,
      source,
    })
    return true
  }

  /** 终局后生成赛后总结并落盘（失败只上报，不影响重放结论）。 */
  private async finishReview(): Promise<string | null> {
    const generator = this.options.reviewGenerator
    if (generator === null || generator === undefined) {
      this.emit({ type: 'replay-review-skipped', reason: '未配置赛后总结生成器' })
      return null
    }
    if (this.archived.length === 0) {
      this.emit({ type: 'replay-review-skipped', reason: '本次重放没有执教的回合（全程快进？）' })
      return null
    }
    const history = await this.readLastHistory()
    const input: ReviewInput = {
      gameIndex: this.options.gameIndex,
      totalTurns: this.progress.totalTurns,
      result: history?.result ?? this.result,
      friendlyName: '',
      opponentName: '',
      friendlyClass: history?.friendly_class ?? 'unknown',
      opponentClass: history?.opponent_class ?? 'unknown',
      coachMode: this.options.coachMode,
      model: this.options.model,
      turns: this.archived,
    }
    try {
      await generator.generateToFile(input, this.reviewPath)
      this.emit({ type: 'replay-review', path: this.reviewPath })
      return this.reviewPath
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'replay-review-skipped', reason: `赛后总结生成失败：${reason}` })
      return null
    }
  }

  /** 读重放战绩文件的最后一行（引擎在该局结束时写入）。 */
  private async readLastHistory(): Promise<{
    result?: string
    friendly_class?: string
    opponent_class?: string
    turns?: number
  } | null> {
    try {
      const text = await readFile(join(this.options.publishDir, 'history.jsonl'), 'utf-8')
      const lines = text.split(/\r?\n/).filter(line => line.length > 0)
      const last = lines[lines.length - 1]
      if (last === undefined) return null
      return JSON.parse(last) as { result?: string; friendly_class?: string; opponent_class?: string }
    } catch {
      return null
    }
  }
}

/** 创建重放会话的工厂参数（harness 只需给日志与目录，其余内部装配）。 */
export interface ReplaySessionOptions {
  logPath: string
  gameIndex: number
  /** 重放发布目录（隔离）。 */
  publishDir: string
  /** 建议缓存目录。 */
  cacheDir: string
  /** 复盘档案目录。 */
  gameDir: string
  baseURL: string
  apiKey: string
  model: string
  coachMode: string
  friendlyPlayerId?: number | null | undefined
  /** 卡牌数据目录（空 = 包内 data/ 自动探测）。 */
  cardDataDir?: string | undefined
  /** 复用的卡牌库（缺席时内部构建，构建较慢，建议复用）。 */
  db?: CardDatabase | undefined
  /** 看门狗上限（回合建议）。 */
  adviceTimeoutMs?: number | undefined
  /** 看门狗上限（赛后总结）。 */
  reviewTimeoutMs?: number | undefined
  /** 单次调用的输出预算（tokens，含推理模型的思考链；建议与总结共用）。 */
  maxTokens?: number | undefined
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch | undefined
  onEvent?: ((event: ReplayEvent) => void) | undefined
  /** 执教回合之间的最小间隔（毫秒）。 */
  minTurnIntervalMs?: number | undefined
}

/**
 * 组装一个重放控制器：卡牌库（可复用）+ 直连 provider + 缓存/规则层 + 总结生成器。
 * @param options - 日志位置、隔离目录与模型配置。
 * @returns 可直接 start/pause/step 的控制器。
 */
export async function createReplayController(
  options: ReplaySessionOptions,
): Promise<ReplayController> {
  const db =
    options.db ??
    (await (async () => {
      const database = new CardDatabaseCtor(
        options.cardDataDir ? [options.cardDataDir, ...defaultDataDirs()] : defaultDataDirs(),
      )
      await database.build()
      return database
    })())
  const provider = new DirectApiAdviceProvider({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    model: options.model,
    timeoutMs: options.adviceTimeoutMs ?? 15_000,
    maxTokens: options.maxTokens,
    fetchImpl: options.fetchImpl,
  })
  let reviewGenerator: ReviewGenerator | null = null
  if (options.apiKey) {
    reviewGenerator = new ReviewGenerator({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
      model: options.model,
      timeoutMs: options.reviewTimeoutMs ?? 30_000,
      maxTokens: options.maxTokens,
      fetchImpl: options.fetchImpl,
    })
  }
  return new ReplayController({
    logPath: options.logPath,
    gameIndex: options.gameIndex,
    publishDir: options.publishDir,
    cacheDir: options.cacheDir,
    gameDir: options.gameDir,
    db,
    adviceProvider: provider,
    coachMode: options.coachMode,
    model: options.model,
    friendlyPlayerId: options.friendlyPlayerId ?? null,
    reviewGenerator,
    onEvent: options.onEvent,
    minTurnIntervalMs: options.minTurnIntervalMs,
  })
}

/** 进度格式化（日志/页面复用同一套文案）。 */
export function formatProgress(progress: ReplayProgress): string {
  const head = `[${progress.phase}] 第 ${progress.gameIndex + 1} 局 T${progress.turn}/${progress.totalTurns}`
  const counts = [
    `执教 ${progress.coached}`,
    `快进 ${progress.skipped}`,
    `缓存 ${progress.cacheHits}`,
    `模型 ${progress.llmCalls}`,
    `规则 ${progress.ruleTurns}`,
  ].join(' · ')
  return `${head} · ${counts}`
}
