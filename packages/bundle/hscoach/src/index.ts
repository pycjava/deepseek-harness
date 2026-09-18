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
import { DirectApiAdviceProvider } from './advice/directProvider.ts'
import { COACH_MODES, DEFAULT_COACH_MODE } from './advice/prompts.ts'
import { aggregate } from './core/history.ts'

/** API root default (official DeepSeek; /v1-compatible endpoints come from config.baseURL). */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** Model default (a low-latency chat model; the coach needs no deep reasoning). */
export const DEFAULT_MODEL = 'deepseek-chat'

/** Default watchdog cap for advice generation, in milliseconds. */
export const DEFAULT_ADVICE_TIMEOUT_MS = 15_000

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
    this.ctx.logger.info(`dsh-hscoach: 卡牌库就绪（${this.db.size} 张）→ ${publishDir}`)

    if (!this.cfg.apiKey) {
      this.ctx.logger.warn(
        'dsh-hscoach: 未配置 API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）——建议生成将降级',
      )
    }

    const provider: AdviceProvider = new DirectApiAdviceProvider({
      baseURL: this.cfg.baseURL,
      apiKey: this.cfg.apiKey,
      model: this.cfg.model,
      timeoutMs: this.cfg.adviceTimeoutMs,
      fetchImpl: this.deps.fetch,
    })

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

    if (this.cfg.autoStart) await this.start()
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
        this.log(`T${event.turn} 建议已发布（${event.latencyMs}ms${event.degraded ? '，降级' : ''}）：${event.headline}`)
        break
      case 'advice-degraded':
        this.ctx.logger.warn(`dsh-hscoach: ${event.reason}`)
        break
      case 'game-result':
        this.log(`对局结束：${event.result}（T${event.turns}）→ ${event.stats.wins}胜${event.stats.losses}负（${event.stats.winrate_pct}%）`)
        break
      default:
        break
    }
  }

  private log(message: string): void {
    this.events.push(message)
    /* v8 ignore next -- 200 条事件环上限需整场 200+ 对局事件，单局功能测试不构造 */
    if (this.events.length > 200) this.events.shift()
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
        case 'start':
          await this.start()
          return { kind: 'success', text: '教练已开始监听 Power.log。' }
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
    /* v8 ignore next 2 -- db 在 init 内构建、引擎 id 恒有默认值，两个 ?? 兜底不可达 */
    const deckSize = this.db?.size ?? 0
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

  private async start(): Promise<void> {
    /* v8 ignore next -- engine 为空的析取臂不可达（init 先于 start 装配） */
    if (this.running || this.stopped || this.engine === null) return
    // 尽力开启炉石日志（失败不阻断——用户可能没装炉石）
    try {
      const status = await this.deps.ensureLogConfig()
      this.log(`log.config: ${status.action}`)
    } catch (error: unknown) {
      this.ctx.logger.warn(`dsh-hscoach: log.config 配置失败（${String(error)}）`)
    }
    const engine = this.engine
    const tail = new this.deps.tail({
      resolvePath: () => this.deps.resolveLogPath(),
      pollIntervalMs: 300,
      shouldStop: () => this.stopped || !this.running,
      onLines: lines => engine.processLines(lines),
    })
    this.tail = tail
    this.running = true
    void tail.run().catch((error: unknown) => {
      this.ctx.logger.error(`dsh-hscoach: tail 异常退出：${String(error)}`)
      this.running = false
    })
    this.log('开始监听 Power.log（打开炉石打一局即开始）')
  }

  private shutdownTail(): void {
    this.running = false
    this.tail?.stop()
    this.tail = null
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
