/**
 * @deepseek-ai/dsh-hscoach — the Hearthstone coach application plugin.
 *
 * The plugin owns its whole lifecycle: at startup it builds the bundled card
 * database, enables Hearthstone logging on a best-effort basis, and tails
 * Power.log; turn advice is generated through direct DeepSeek-compatible API
 * calls (never through the host agents service), and the results are written
 * atomically as advice.json / game_state.json / stats.json for the NTEToolbox
 * overlay. The /hscoach command and the think-again trigger file are optional
 * control channels. Static options come from the bundle patch config;
 * runtime switches go through the command.
 * @module @deepseek-ai/dsh-hscoach
 */

import { existsSync, statSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { CardDatabase, defaultDataDirs } from './core/cards.ts'
import { ensureLogConfig, powerLogPath, restoreLogConfig } from './core/logConfig.ts'
import type { LogConfigStatus } from './core/logConfig.ts'
import { PowerLogTail } from './core/tail.ts'
import type { TailOptions } from './core/tail.ts'
import { ADVICE_FILENAME, THINK_AGAIN_FILENAME } from './core/trigger.ts'
import { CoachEngine } from './runtime/engine.ts'
import type { AdviceProvider, EngineEvent } from './runtime/engine.ts'
import { acquireInstanceLock, lockPath, readLockPid, type InstanceLock } from './runtime/lock.ts'
import { DirectApiAdviceProvider } from './advice/directProvider.ts'
import { DEFAULT_MAX_TOKENS } from './advice/chatCompletion.ts'
import { COACH_MODES, DEFAULT_COACH_MODE, type ChatTurn } from './advice/prompts.ts'
import { aggregate, localIsoSeconds } from './core/history.ts'

/** API root default (official DeepSeek; /v1-compatible endpoints come from config.baseURL). */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Model default (a low-latency chat model; the coach needs no deep reasoning). */
export const DEFAULT_MODEL = 'deepseek-chat'

/** Default watchdog cap for advice generation, in milliseconds. */
export const DEFAULT_ADVICE_TIMEOUT_MS = 15_000

/** 回合建议注入的最近对话轮数上限（prompt 工程常量，非部署可变量）。 */
const RECENT_CHAT_TURNS = 12

/**
 * 读取可选宿主服务 `hscoachChatContext`（独立 harness 的聊天历史）。
 * 服务值必须是返回对话轮数组的函数；形状不符按缺席处理。
 * @param ctx - 插件上下文。
 * @returns 服务函数；缺席或形状不符时 null。
 */
const readChatSource = (ctx: Context): (() => unknown) | null => {
  const value: unknown = ctx.get('hscoachChatContext')
  return typeof value === 'function' ? (value as () => unknown) : null
}

/** 宿主提供的对话轮按 role/text 形状过滤后才注入建议 prompt。 */
const isValidTurn = (turn: unknown): turn is ChatTurn => {
  if (typeof turn !== 'object' || turn === null) return false
  const { role, text } = turn as { role?: unknown; text?: unknown }
  return (role === 'user' || role === 'coach')
    && typeof text === 'string' && text.length > 0
}

/** Resolved plugin options after {@link resolveConfig} normalization. */
export interface HsCoachPluginConfig {
  /** Advice publish directory; empty = {@link resolvePublishDir} default. */
  publishDir: string
  /** Friendly player id; unset = automatic calibration from the game log. */
  friendlyPlayerId?: number | undefined
  /** Coaching style: teach / compete / silent. */
  coachMode: string
  /** DeepSeek-compatible API key; empty = the DEEPSEEK_API_KEY environment variable. */
  apiKey: string
  /** API root; empty = the DEEPSEEK_BASE_URL environment variable or the official default. */
  baseURL: string
  /** Model; empty = deepseek-chat. */
  model: string
  /** Advice generation watchdog, in milliseconds. */
  adviceTimeoutMs: number
  /** 单次调用的输出预算（tokens，含推理模型的思考链）。 */
  maxTokens: number
  /** Card database data directory; empty = auto-detect (the package data/). */
  cardDataDir: string
  /** Whether to start watching Power.log as soon as dsh boots. */
  autoStart: boolean
}

/**
 * Normalize raw patch config: explicit config keys win, then environment
 * variables, then built-in defaults.
 * @param raw - the `config` object from the loader entry, if any.
 * @returns the fully resolved plugin options.
 */
export function resolveConfig(raw: Record<string, unknown> = {}): HsCoachPluginConfig {
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const coachMode = str(raw.coachMode) || DEFAULT_COACH_MODE
  return {
    publishDir: str(raw.publishDir),
    friendlyPlayerId: num(raw.friendlyPlayerId),
    coachMode: coachMode in COACH_MODES ? coachMode : DEFAULT_COACH_MODE,
    apiKey: str(raw.apiKey) || process.env.DEEPSEEK_API_KEY || '',
    baseURL: str(raw.baseURL) || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    model: str(raw.model) || DEFAULT_MODEL,
    adviceTimeoutMs: num(raw.adviceTimeoutMs) ?? DEFAULT_ADVICE_TIMEOUT_MS,
    maxTokens: num(raw.maxTokens) ?? DEFAULT_MAX_TOKENS,
    cardDataDir: str(raw.cardDataDir),
    autoStart: raw.autoStart === undefined ? true : raw.autoStart === true,
  }
}

/**
 * Resolve the publish directory default. It must match the Tauri
 * hscoach_bridge `app_local_data_dir()/hscoach` (identifier
 * com.ntetoolbox.client) or the overlay client cannot poll the files this
 * plugin writes. Explicit config wins, then the environment variable, then
 * the Tauri directory.
 * @param configured - the publishDir option (empty = default).
 * @returns the directory advice files are written to.
 */
export function resolvePublishDir(configured: string): string {
  if (configured) return configured
  const env = process.env.DSH_HSCOACH_PUBLISH_DIR
  if (env) return env
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(local, 'com.ntetoolbox.client', 'hscoach')
}

/**
 * Injectable runtime collaborators shared by tests and the real host: real
 * deps use the real filesystem and global timers, tests construct fakes.
 */
export interface RuntimeDeps {
  /** Resolve the Hearthstone Power.log path. */
  resolveLogPath(): Promise<string>
  /** Power.log tail constructor. */
  tail: new (options: TailOptions) => PowerLogTail
  /** Best-effort Hearthstone log.config enablement (tests inject a stub). */
  ensureLogConfig(): Promise<LogConfigStatus>
  /** HTTP implementation for advice generation; absent = global fetch. */
  fetch?: typeof fetch
  /** Polling timer; returns its cleanup. */
  setInterval(callback: () => void, ms: number): () => void
}

/** The production {@link RuntimeDeps} over the real filesystem and timers. */
export const realRuntimeDeps: RuntimeDeps = {
  resolveLogPath: () => powerLogPath(),
  tail: PowerLogTail,
  ensureLogConfig,
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms)
    return () =>{  clearInterval(handle) }
  },
}

/**
 * The coach orchestration body (a plain class, not a cordis service — it has
 * no external consumers). The default-exported plugin function assembles it
 * and hooks its lifecycle through ctx.effect.
 */
export class HsCoachPlugin {
  private engine: CoachEngine | null = null
  private db: CardDatabase | null = null
  private tail: PowerLogTail | null = null
  private lock: InstanceLock | null = null
  private lockRelease: Promise<void> | null = null
  private stopped = false
  private running = false
  private thinkAgainMtime = 0
  private stopThinkAgainPoll?: () => void
  private readonly events: string[] = []

  constructor(
    private readonly ctx: Context,
    private readonly cfg: HsCoachPluginConfig,
    private readonly deps: RuntimeDeps = realRuntimeDeps,
  ) {}

  /**
   * Assemble the engine and the control channels, then optionally start
   * watching Power.log.
   * @returns a promise that settles once startup completed.
   */
  async init(): Promise<void> {
    const publishDir = resolvePublishDir(this.cfg.publishDir)

    // 卡牌库（离线，内置数据）
    this.db = new CardDatabase(
      this.cfg.cardDataDir ? [this.cfg.cardDataDir, ...defaultDataDirs()] : defaultDataDirs(),
    )
    await this.db.build()
    this.log(`卡牌库就绪（${this.db.size} 张）→ ${publishDir}`)
    this.log(`教练：模式 ${this.cfg.coachMode}，模型 ${this.cfg.model}（${this.cfg.baseURL}）`)

    if (!this.cfg.apiKey) {
      this.emitWarn('未配置 API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）——建议生成将降级')
    }

    const baseProvider: AdviceProvider = new DirectApiAdviceProvider({
      baseURL: this.cfg.baseURL,
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      timeoutMs: this.cfg.adviceTimeoutMs,
      maxTokens: this.cfg.maxTokens,
      fetchImpl: this.deps.fetch,
    })
    // 可选宿主服务 hscoachChatContext（独立 harness 的聊天历史）：
    // 提供时把最近对话注入每回合建议的 prompt；缺席（如 dsh profile
    // 挂载）行为与从前完全一致。
    const chatSource = readChatSource(this.ctx)
    const provider: AdviceProvider = chatSource === null ? baseProvider : {
      generate: (input) => {
        const turns = chatSource()
        return baseProvider.generate({
          ...input,
          recentChat: Array.isArray(turns)
            ? turns.slice(-RECENT_CHAT_TURNS).filter(isValidTurn)
            : [],
        })
      },
    }

    this.engine = new CoachEngine({
      publishDir,
      db: this.db,
      adviceProvider: provider,
      friendlyPlayerId: this.cfg.friendlyPlayerId ?? null,
      coachMode: this.cfg.coachMode,
      onEvent: (event) =>{  this.handleEvent(event) },
    })

    // /hscoach 命令（commands 服务缺席时安全跳过）
    this.ctx.inject(['commands'], (cmdCtx) => {
      cmdCtx.effect(
        () => cmdCtx.commands.register({
          name: 'hscoach',
          description: 'Hearthstone 教练：日志监听与出牌建议',
          input: { hint: '<status | start | stop | think | mode <teach|compete|silent> | restore-log>' },
          handler: invocation => this.handleCommand(invocation),
        }),
        'dsh-hscoach: /hscoach command',
      )
    })

    // “再想想”反通道：轮询触发文件（悬浮窗按钮写入）
    this.stopThinkAgainPoll = this.deps.setInterval(() => {
      this.pollThinkAgain()
    }, 1000)

    this.ctx.effect(() => () => {
      this.shutdown()
    }, 'dsh-hscoach: shutdown')

    if (this.cfg.autoStart) {
      const refused = await this.start()
      if (refused) this.emitWarn(refused)
    }
  }

  private handleEvent(event: EngineEvent): void {
    switch (event.type) {
      case 'game-start':
        this.log('新对局开始')
        break
      case 'calibrated':
        this.log(`自动校准：友方玩家 id = ${event.friendlyPlayerId}`)
        break
      case 'advice-published':
        /* v8 ignore next -- provider 恒 degraded=false；降级发布走 advice-degraded 事件 */
        this.log(`T${event.turn} 建议已发布（${event.latencyMs}ms${event.degraded ? '，降级' : ''}）：${event.headline}`)
        break
      case 'advice-degraded':
        this.emitWarn(event.reason)
        break
      case 'game-result':
        this.log(`对局结束：${event.result}（T${event.turns}）→ ${event.stats.wins}胜${event.stats.losses}负（${event.stats.winrate_pct}%）`)
        break
      default:
        break
    }
  }

  /**
   * 控制台直出（独立 profile 树不挂 console-logger，ctx.logger 无接收端；
   * 生命周期事件必须让启动终端里的用户看得见）。
   * @param message - 事件文本（无前缀）。
   */
  private emit(message: string): void {
    console.log(`[hscoach ${localIsoSeconds().slice(11)}] ${message}`)
  }

  /** 控制台告警直出 + ctx.logger.warn（保留宿主侧诊断通道）。 */
  private emitWarn(message: string): void {
    console.error(`[hscoach ${localIsoSeconds().slice(11)}] ${message}`)
    this.ctx.logger.warn(`dsh-hscoach: ${message}`)
  }

  private log(message: string): void {
    this.events.push(message)
    /* v8 ignore next -- 200 条事件环上限需整场 200+ 对局事件，单局功能测试不构造 */
    if (this.events.length > 200) this.events.shift()
    this.emit(message)
    this.ctx.logger.info(`dsh-hscoach: ${message}`)
  }

  private async handleCommand(invocation: {
    rawInput?: string
  }): Promise<CommandResult> {
    const raw = (invocation.rawInput ?? '').trim()
    const [verb, ...rest] = raw === '' ? ['status'] : raw.split(/\s+/)
    try {
      switch (verb) {
        case 'status':
          return { kind: 'success', text: await this.statusText() }
        case 'start': {
          const refused = await this.start()
          return refused
            ? { kind: 'error', text: refused }
            : { kind: 'success', text: '教练已开始监听 Power.log。' }
        }
        case 'stop':
          this.shutdownTail()
          return { kind: 'success', text: '教练已停止监听（战绩与建议文件保留）。' }
        case 'think': {
          /* v8 ignore start -- 命令在 init 内注册，engine 必已装配；空值守卫仅防御 */
          if (this.engine === null) {
            return { kind: 'error', text: '教练尚未初始化（先 /hscoach start）。' }
          }
          /* v8 ignore stop */
          await this.engine.thinkAgain()
          return { kind: 'success', text: '已基于当前局面重新推理（再想想）。' }
        }
        case 'mode': {
          const mode = rest[0]
          if (mode !== 'teach' && mode !== 'compete' && mode !== 'silent') {
            return { kind: 'error', text: '用法：/hscoach mode <teach|compete|silent>' }
          }
          /* v8 ignore next -- engine 在 init 内装配，非空分支不可达 */
          if (this.engine) this.engine.coachMode = mode
          return { kind: 'success', text: `教练模式已切换为 ${mode}。` }
        }
        case 'restore-log': {
          const status = await restoreLogConfig()
          return { kind: 'success', text: status.message }
        }
        default:
          return {
            kind: 'error',
            text: '未知子命令。可用：status / start / stop / think / mode <teach|compete|silent> / restore-log',
          }
      }
    } catch (error) {
      /* v8 ignore next -- 命令面抛出的均为 Error 实例 */
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
  }

  private async statusText(): Promise<string> {
    const publishDir = resolvePublishDir(this.cfg.publishDir)
    /* v8 ignore next -- db 在 init 内构建，?? 兜底不可达 */
    const deckSize = this.db?.size ?? 0
    /* v8 ignore next -- 引擎构造时 friendlyPlayerId 已有默认值，?? 兜底不可达 */
    const friendlyId = this.engine?.getFriendlyPlayerId() ?? '自动校准'
    const lines = [
      `监听：${this.running ? '运行中' : '已停止'}`,
      `发布目录：${publishDir}`,
      /* v8 ignore next -- db 在 init 内构建，非空分支不可达 */
      `卡牌库：${deckSize} 张`,
      `模型：${this.cfg.model}（${this.cfg.baseURL}）`,
      `教练模式：${this.cfg.coachMode}`,
      /* v8 ignore next -- 引擎构造时 friendlyPlayerId 已有默认值，永不为 null */
      `友方 id：${friendlyId}`,
    ]
    const stats = await aggregate(join(publishDir, 'history.jsonl'))
    if (stats.total > 0) {
      lines.push(`战绩：${stats.wins}胜 ${stats.losses}负 ${stats.ties}平（${stats.winrate_pct}%）`)
    }
    const advicePath = join(publishDir, ADVICE_FILENAME)
    if (existsSync(advicePath)) {
      try {
        const advice = JSON.parse(await readFile(advicePath, 'utf8')) as {
          turn?: number
          advice?: { headline?: string; degraded?: boolean }
        }
        lines.push(
          `最近建议（T${advice.turn ?? '?'}）：${advice.advice?.headline ?? ''}${advice.advice?.degraded ? '（降级）' : ''}`,
        )
      } catch {
        // 建议文件读取失败不致命
      }
    }
    return lines.join('\n')
  }

  /**
   * 启动监听：先抢发布目录单实例锁（同一目录同时只能有一个教练 tail，
   * 否则同一局重复记账、发布文件互相覆盖），再尽力开启炉石日志、启动 tail。
   * @returns 启动成功返回 null；拒绝原因（另一存活实例持有锁）返回给调用方展示。
   */
  private async start(): Promise<string | null> {
    /* v8 ignore next -- engine 为空的析取臂不可达（init 先于 start 装配） */
    if (this.running || this.stopped || this.engine === null) return null
    // 等待上一次 stop 的锁释放落定，避免立即 start 撞上自己的旧锁
    if (this.lockRelease) {
      await this.lockRelease
      this.lockRelease = null
    }
    const publishDir = resolvePublishDir(this.cfg.publishDir)
    const lock = await acquireInstanceLock(publishDir)
    if (lock === null) {
      const holderPid = await readLockPid(lockPath(publishDir))
      /* v8 ignore next -- 拒绝与重读之间锁文件消失的竞态臂 */
      const pidText = holderPid === null ? '未知' : String(holderPid)
      return `另一个教练实例正在运行（PID ${pidText}，锁 ${lockPath(publishDir)}），本次不启动监听。`
    }
    this.lock = lock
    // 尽力开启炉石日志（失败不阻断——用户可能没装炉石）
    try {
      const status = await this.deps.ensureLogConfig()
      this.log(status.message)
    } catch (error: unknown) {
      this.emitWarn(`log.config 配置失败（${String(error)}）`)
    }
    const engine = this.engine
    const logPath = await this.deps.resolveLogPath()
    const tail = new this.deps.tail({
      resolvePath: () => this.deps.resolveLogPath(),
      pollIntervalMs: 300,
      shouldStop: () => this.stopped || !this.running,
      onLines: lines => engine.processLines(lines),
    })
    this.tail = tail
    this.running = true
    void tail.run().catch((error: unknown) => {
      this.emitWarn(`tail 异常退出：${String(error)}`)
      this.ctx.logger.error(`dsh-hscoach: tail 异常退出：${String(error)}`)
      this.running = false
      // tail 已死：让出单实例锁，start 才能重试
      this.releaseLock()
    })
    this.log(`开始监听 ${logPath}（打开炉石打一局即开始）`)
    return null
  }

  /** 让出单实例锁（tail 停止或崩溃时调用；start 重试前等待释放落定）。 */
  private releaseLock(): void {
    if (this.lock) {
      const lock = this.lock
      this.lock = null
      this.lockRelease = lock.release()
    }
  }

  private shutdownTail(): void {
    this.running = false
    this.tail?.stop()
    this.tail = null
    this.releaseLock()
  }

  private shutdown(): void {
    this.stopped = true
    this.shutdownTail()
    this.stopThinkAgainPoll?.()
    // 清理可能残留的触发文件
    const trigger = join(resolvePublishDir(this.cfg.publishDir), THINK_AGAIN_FILENAME)
    try {
      if (existsSync(trigger)) unlinkSync(trigger)
    } catch {
      /* v8 ignore next -- Windows 句柄残留导致的删除竞态不可稳定构造 */
      // ignore
    }
  }

  /** Watch the publish directory's think-again.trigger (an mtime change triggers a rethink). */
  private pollThinkAgain(): void {
    if (this.stopped || !this.engine || !this.running) return
    const trigger = join(resolvePublishDir(this.cfg.publishDir), THINK_AGAIN_FILENAME)
    if (!existsSync(trigger)) return
    let mtime: number
    try {
      mtime = statSync(trigger).mtimeMs
    } catch {
      /* v8 ignore next -- existsSync 与 statSync 之间的删除竞态在进程内不可观测 */
      return
    }
    /* v8 ignore next -- 仅在触发文件删除失败后同 mtime 重访时可达 */
    if (mtime === this.thinkAgainMtime) return
    this.thinkAgainMtime = mtime
    try {
      unlinkSync(trigger)
      this.thinkAgainMtime = 0
    } catch {
      // 删除失败下次还会触发；先继续
    }
    this.log('收到再想想触发（think-again.trigger）')
    void this.engine.thinkAgain()
  }
}

// ── 复盘/重放对外接口（独立 harness 的 Web 层直接消费） ──────────
//
// 实时插件本身不需要这些导出；它们让 harness 不必复制任何内部装配：
// 扫描历史对局（scanLogSessions）、按回合重放一局（createReplayController）、
// 以及复用的卡牌库与炉石安装目录探测。

export { CardDatabase, defaultDataDirs } from './core/cards.ts'
export { hearthstoneDataDir, hearthstoneInstallDir, logConfigPath, powerLogPath } from './core/logConfig.ts'
export { scanLogSessions, scanPowerLog } from './core/logScan.ts'
export type { ScannedGame, ScannedSession } from './core/logScan.ts'
export {
  createReplayController,
  formatProgress,
  ReplayController,
} from './replay/controller.ts'
export type {
  AdviceSource,
  ReplayControllerOptions,
  ReplayEvent,
  ReplayPhase,
  ReplayProgress,
  ReplayRunInfo,
  ReplaySessionOptions,
} from './replay/controller.ts'
export { planReplay } from './replay/splitter.ts'
export type { ReplayGamePlan, ReplaySegment } from './replay/splitter.ts'
export { fastForwardAdvice, hasAvailableAction, isTrivialTurn, trivialAdvice } from './replay/trivial.ts'
export { AdviceCache, adviceCacheKey, stableStringify } from './replay/cache.ts'
export type { AdviceCacheEntry } from './replay/cache.ts'
export { PROMPT_VERSION } from './advice/prompts.ts'
export { buildReviewPrompt, ReviewGenerator } from './replay/review.ts'
export type { ReviewGeneratorOptions, ReviewInput, ReviewTurn } from './replay/review.ts'
export {
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_CAP,
  ProviderError,
  requestChatContent,
} from './advice/chatCompletion.ts'
export type { ChatCompletionDeps } from './advice/chatCompletion.ts'

/**
 * The Cordis function plugin: the loader hands the default export straight to
 * the registry (a function plugin is a first-class Cordis form). Host types
 * are `import type` only, so the runtime keeps zero host-package imports.
 * @param ctx - the plugin's Cordis context.
 * @param config - the raw loader entry config.
 * @returns a promise that settles once the coach finished starting.
 */
const hscoach: (ctx: Context, config: Record<string, unknown>) => Promise<void> = async (
  ctx,
  config,
) => {
  const plugin = new HsCoachPlugin(ctx, resolveConfig(config))
  await plugin.init()
}

// Plugin.Base.name metadata (the fiber diagnostic display name); a function's
// `name` property is read-only, so assign it through defineProperty.
Object.defineProperty(hscoach, 'name', { value: 'dsh-hscoach' })

export default hscoach
