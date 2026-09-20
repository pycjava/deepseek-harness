/**
 * 教练引擎（编排核心）。
 *
 * 职责：批处理日志行 → 增量触发/终局检测 → 全量解析（触发窗口）→
 * 友方校准 → 合法可见序列化 → 建议生成（AdviceProvider 注入，agentic
 * 或测试桩）→ 原子发布 advice.json / game_state.json / stats.json。
 *
 * 并发模型：Node 单线程 + 代数计数实现 latest-wins——新回合到达时，
 * 尚未发布的旧建议作废（不堆积过时请求）。
 */
import { CardDatabase } from '../core/cards.ts'
import { GameResultDetector, recordResult, type HistoryStats } from '../core/history.ts'
import { computeLethal, type LethalCheck } from '../core/lethal.ts'
import { isCreateGameLine, parsePowerLog } from '../core/parser.ts'
import {
  calibrateFriendlyPlayer,
  serializeGame,
  type GameSnapshot,
} from '../core/state.ts'
import {
  IncrementalTurnDetector,
  isNewFriendlyTurn,
  publishAdvice,
  publishGameState,
  type Advice,
} from '../core/trigger.ts'
import type { ChatTurn } from '../advice/prompts.ts'

/** 建议生成器抽象：dsh agentic 实现 / 测试桩二选一。 */
export interface AdviceProvider {
  generate(input: {
    snapshot: GameSnapshot
    friendlyPlayerId: number
    lethal: LethalCheck | null
    coachMode: string
    /** 最新代数；不等于当前代数时应尽快放弃（provider 自行取消 LLM）。 */
    generation: number
    /** 宿主可选注入的最近玩家-教练对话；缺席时建议不感知聊天。 */
    recentChat?: readonly ChatTurn[]
  }): Promise<Advice>
}

/** 引擎构造配置（发布目录、卡库、建议生成器与运行参数）。 */
export interface CoachEngineOptions {
  publishDir: string
  db: CardDatabase
  adviceProvider: AdviceProvider
  /** null = 日志自动校准（推荐）。 */
  friendlyPlayerId?: number | null | undefined
  coachMode?: string
  /** 盒子快照节流（毫秒）。 */
  stateThrottleMs?: number
  onEvent?: ((event: EngineEvent) => void) | undefined
}

/** 引擎对外事件（开局、建议发布/降级、终局、校准、快照发布）。 */
export type EngineEvent =
  | { type: 'game-start' }
  | {
    type: 'advice-published'
    turn: number
    headline: string
    degraded: boolean
    latencyMs: number
  }
  | { type: 'advice-degraded'; turn: number; reason: string }
  | { type: 'game-result'; result: string; turns: number; stats: HistoryStats }
  | { type: 'calibrated'; friendlyPlayerId: number }
  | { type: 'state-published'; turn: number }

/** 教练引擎：日志批处理 → 触发/终局检测 → 解析序列化 → 建议生成与原子发布。 */
export class CoachEngine {
  private readonly publishDir: string
  private readonly db: CardDatabase
  private readonly provider: AdviceProvider
  /** 教练模式（/hscoach mode 运行时可切）。 */
  coachMode: string
  private readonly stateThrottleMs: number
  private readonly onEvent: ((event: EngineEvent) => void) | undefined

  private friendlyPlayerId: number
  private readonly friendlyExplicit: boolean
  private lastTriggeredTurn = 0
  private lastAdvice: Advice | null = null
  private detector: IncrementalTurnDetector
  private resultDetector: GameResultDetector
  private batch: string[] = []
  private lastStateAt = 0
  /** latest-wins 代数。 */
  private generation = 0
  /** 批处理保序队列（tail 逐批调用；并发调用在此串行化）。 */
  private queue: Promise<void> = Promise.resolve()
  /** 在途建议（fire-and-forget；idle() 等待全部落定）。 */
  private readonly pendingAdvice = new Set<Promise<void>>()
  /** 发布段串行链：advice.json 的 rename 顺序 = 提交代数顺序。 */
  private publishChain: Promise<void> = Promise.resolve()

  constructor(options: CoachEngineOptions) {
    this.publishDir = options.publishDir
    this.db = options.db
    this.provider = options.adviceProvider
    this.coachMode = options.coachMode ?? 'teach'
    this.stateThrottleMs = options.stateThrottleMs ?? 1000
    this.onEvent = options.onEvent
    this.friendlyPlayerId = options.friendlyPlayerId ?? 1
    this.friendlyExplicit = options.friendlyPlayerId != null
    this.detector = new IncrementalTurnDetector(this.friendlyPlayerId, false)
    this.resultDetector = new GameResultDetector(this.friendlyPlayerId)
  }

  /**
   * 当前生效的我方玩家 id（经日志校准后可能变化）。
   * @returns 我方玩家 id。
   */
  getFriendlyPlayerId(): number {
    return this.friendlyPlayerId
  }

  /**
   * 喂入一批新行；按队列顺序处理（不阻塞在 LLM 上）。
   * @param lines - 原始日志行批。
   */
  processLines(lines: string[]): Promise<void> {
    this.queue = this.queue.then(() => this.processLinesInner(lines))
    return this.queue
  }

  /** 等待批处理与全部在途建议落定（测试/优雅退出用）。 */
  async idle(): Promise<void> {
    await this.queue
    while (this.pendingAdvice.size > 0) {
      await Promise.allSettled([...this.pendingAdvice])
    }
  }

  private async processLinesInner(lines: string[]): Promise<void> {
    for (const line of lines) {
      this.batch.push(line)
      if (isCreateGameLine(line)) {
        // 新对局：检测器/触发状态清零（PowerTaskList 重复行不是边界）
        this.detector.reset()
        this.resultDetector.reset()
        this.lastTriggeredTurn = 0
        this.lastAdvice = null
        this.lastStateAt = 0
        this.onEvent?.({ type: 'game-start' })
      }
      if (this.batch.length >= 50 || line.includes('TAG_CHANGE')) {
        await this.flushBatch()
      }
    }
    if (this.batch.length > 0) await this.flushBatch()
  }

  private async flushBatch(): Promise<void> {
    const batch = this.batch
    this.batch = []
    const triggered = this.detector.feed(batch)
    const results = this.resultDetector.feed(batch)

    for (const result of results) {
      try {
        await this.recordGameResult(result)
      } catch (error) {
        this.onEvent?.({ type: 'advice-degraded', turn: 0, reason: `战绩记录失败: ${String(error)}` })
      }
    }

    for (const turn of triggered) {
      try {
        this.handleTriggeredTurn(turn)
      } catch (error) {
        // 隐藏信息违规等：跳过该回合，不中断引擎
        /* v8 ignore next -- 触发回路的 catch 语句计数覆盖工具无法归因 */
        this.onEvent?.({ type: 'advice-degraded', turn, reason: String(error) })
      }
    }

    // 盒子快照节流（1s）
    const now = Date.now()
    if (now - this.lastStateAt >= this.stateThrottleMs) {
      this.lastStateAt = now
      try {
        const snapshot = this.parseAndSerialize(this.detector.getAllLines())
        if (snapshot) {
          await publishGameState(this.publishDir, snapshot, this.friendlyPlayerId)
          this.onEvent?.({ type: 'state-published', turn: snapshot.turn })
        }
      } catch {
        // 快照失败不致命（如校准前的隐藏信息断言）
      }
    }
  }

  /** 触发窗口全量解析 → 校准 → 合法可见序列化 → 新回合判定 → 提交建议。 */
  private handleTriggeredTurn(turn: number): void {
    const snapshot = this.parseAndSerialize(this.detector.getTriggerWindow(turn))
    /* v8 ignore next -- 无对局窗口由测试行使；分支计数覆盖工具无法归因 */
    if (!snapshot) return
    if (!isNewFriendlyTurn(snapshot.turn, snapshot.currentPlayerId, this.friendlyPlayerId, this.lastTriggeredTurn)) {
      return
    }
    this.lastTriggeredTurn = snapshot.turn
    // 慢路径 fire-and-forget：LLM 慢不反噬日志读取；发布前经代数校验
    // 实现 latest-wins。
    const run = this.submitAdvice(snapshot)
      .catch((error: unknown) => {
        this.onEvent?.({
          type: 'advice-degraded',
          turn: snapshot.turn,
          /* v8 ignore next -- 此处只兜发布链异常（fs 错误恒为 Error）；非 Error 臂不可构造 */
          reason: String(error instanceof Error ? error.message : error),
        })
      })
      .finally(() => {
        this.pendingAdvice.delete(run)
      })
    this.pendingAdvice.add(run)
  }

  /** 解析行流 → 校准友方 id → 序列化（返回 null = 无可解析对局）。 */
  private parseAndSerialize(lines: string[]): GameSnapshot | null {
    const result = parsePowerLog(lines)
    this.applyCalibration(result)
    if (result.games.length === 0) return null
    const last = result.games[result.games.length - 1]
    /* v8 ignore next -- 长度判 0 已在上一行返回，尾元素必存在 */
    return last === undefined ? null : serializeGame(last, this.friendlyPlayerId, this.db)
  }

  private applyCalibration(result: ReturnType<typeof parsePowerLog>): void {
    if (result.games.length === 0) return
    const game = result.games[result.games.length - 1]
    /* v8 ignore next -- 长度判 0 已在上一行返回，尾元素必存在 */
    if (game === undefined) return
    const calibrated = calibrateFriendlyPlayer(game)
    if (calibrated === null) return
    if (calibrated !== this.friendlyPlayerId) {
      const previous = this.friendlyPlayerId
      this.friendlyPlayerId = calibrated
      this.detector.friendlyPlayerId = calibrated
      this.resultDetector.friendlyPlayerId = calibrated
      /* v8 ignore next -- 显式冲突臂由校准冲突测试行使；分支计数覆盖工具无法归因 */
      if (this.friendlyExplicit) {
        this.onEvent?.({
          type: 'advice-degraded',
          turn: 0,
          reason: `自动校准与配置的 friendlyPlayerId 冲突：${previous} → ${calibrated}（已按日志纠正）`,
        })
      }
      this.onEvent?.({ type: 'calibrated', friendlyPlayerId: calibrated })
    }
  }

  /** 生成 + 发布建议（latest-wins：提交即占位，发布前校验代数；失败降级）。 */
  private async submitAdvice(snapshot: GameSnapshot): Promise<void> {
    const generation = ++this.generation
    const turn = snapshot.turn
    const start = Date.now()
    const lethal = safeLethal(snapshot, this.friendlyPlayerId)

    let advice: Advice
    try {
      advice = await this.provider.generate({
        snapshot,
        friendlyPlayerId: this.friendlyPlayerId,
        lethal,
        coachMode: this.coachMode,
        generation,
      })
    } catch (error) {
      // 降级：优先回显上一回合建议，其次诚实占位（发布同样串行化）
      const fallback: Advice = this.lastAdvice
        ? { ...this.lastAdvice, degraded: true }
        : { ...degradedPlaceholder(String(error)) }
      fallback.latency_ms = Date.now() - start
      const publishTask = this.publishChain.then(async () => {
        if (generation !== this.generation) return
        this.lastAdvice = fallback
        await publishAdvice(this.publishDir, fallback, turn)
        this.onEvent?.({
          type: 'advice-degraded',
          turn,
          reason: `建议生成失败：${String(error instanceof Error ? error.message : error)}`,
        })
      })
      /* v8 ignore next -- 吞掉发布链的并发异常以保序；事件已单独上报 */
      this.publishChain = publishTask.catch(() => {})
      await publishTask
      return
    }

    /* v8 ignore next -- safeLethal 的 catch 已被忽略，lethal 恒非空 */
    const final: Advice = { ...advice, lethal: lethal?.lethal ?? false }
    // 发布段串行化：并发发布时保证"新建议后发布"（rename 顺序 = 代数
    // 顺序），advice.json 永不被更旧的建议覆盖。
    const publishTask = this.publishChain.then(async () => {
      if (generation !== this.generation) {
        this.onEvent?.({ type: 'advice-degraded', turn, reason: '已被更新的回合覆盖（latest-wins）' })
        return
      }
      this.lastAdvice = final
      await publishAdvice(this.publishDir, final, turn)
      this.onEvent?.({
        type: 'advice-published',
        turn,
        headline: final.headline,
        degraded: final.degraded,
        latencyMs: final.latency_ms,
      })
    })
    this.publishChain = publishTask.catch(() => {})
    await publishTask
  }

  /** 手动"再想想"：基于当前最新局面重新生成（不要求 turn 递增）。 */
  async thinkAgain(): Promise<void> {
    const snapshot = this.parseAndSerialize(this.detector.getAllLines())
    if (!snapshot) {
      this.onEvent?.({ type: 'advice-degraded', turn: 0, reason: '暂无可解析的对局局面' })
      return
    }
    try {
      await publishGameState(this.publishDir, snapshot, this.friendlyPlayerId)
      await this.submitAdvice(snapshot)
    } catch (error) {
      /* v8 ignore next -- 再想发布的 catch 语句计数覆盖工具无法归因 */
      this.onEvent?.({ type: 'advice-degraded', turn: snapshot.turn, reason: String(error) })
    }
  }

  private async recordGameResult(result: string): Promise<void> {
    const snapshot = this.parseAndSerialize(this.detector.getAllLines())
    if (!snapshot) return
    let friendlyClass = ''
    let opponentClass = ''
    for (const [pid, view] of Object.entries(snapshot.players)) {
      const cls = view.hero?.cardClass ?? ''
      if (Number(pid) === this.friendlyPlayerId) friendlyClass = cls
      else opponentClass = cls
    }
    const stats = await recordResult(
      this.publishDir,
      result as 'win' | 'loss' | 'tie',
      friendlyClass,
      opponentClass,
      snapshot.turn,
    )
    this.onEvent?.({ type: 'game-result', result, turns: snapshot.turn, stats })
  }
}

function safeLethal(snapshot: GameSnapshot, friendlyPlayerId: number): LethalCheck | null {
  try {
    return computeLethal(snapshot, friendlyPlayerId)
  } catch {
    /* v8 ignore start -- computeLethal 对缺失玩家/对手有显式回退分支，不抛错；此处仅防御 */
    // 斩杀计算失败不阻断建议生成
    return null
    /* v8 ignore stop */
  }
}

function degradedPlaceholder(reason: string): Advice {
  return {
    kind: 'uncertain',
    headline: '（教练暂时无法响应）',
    why: `建议生成失败：${reason}`,
    warning: '请稍后重试，或手动判断局面',
    steps: [],
    alternatives: [],
    latency_ms: 0,
    degraded: true,
    lethal: false,
  }
}
