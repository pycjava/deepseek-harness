/**
 * 建议缓存：同一「局面 + 模型 + 教练模式」只花一次调用。
 *
 * 复盘的核心用法就是反复重放同一局（换模式对比、回看某几回合），缓存让重复
 * 重放几乎零成本，同时天然成为复盘档案的一部分。键里含模型、模式与 prompt
 * 语义版本，因此"换个配置再看一遍"永远是真实调用——这正是测试教练模式
 * 所需要的；prompt 风格变更也会让旧建议自然失效。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROMPT_VERSION } from '../advice/prompts.ts'
import { atomicWriteJson, localIsoSeconds } from '../core/history.ts'
import { snapshotToContract, type GameSnapshot } from '../core/state.ts'
import type { Advice } from '../core/trigger.ts'

/** 缓存条目（落盘 JSON）。 */
export interface AdviceCacheEntry {
  /** 缓存键（sha256）。 */
  key: string
  /** 生成该建议的模型。 */
  model: string
  /** 生成该建议时的教练模式。 */
  coachMode: string
  /** 生成时的回合号。 */
  turn: number
  /** 建议本体（发布契约的 advice 字段）。 */
  advice: Advice
  /** 写入时间（本地 ISO 秒）。 */
  cachedAt: string
}

/**
 * 稳定序列化：对象键递归排序，保证同一局面产生同一字符串。
 * @param value - 任意可 JSON 化的值。
 * @returns 键序稳定的 JSON 字符串。
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/**
 * 计算建议缓存键：模型 + 教练模式 + prompt 语义版本 + 局面契约（稳定序列化）。
 * prompt 语义变化（如篇幅铁律）通过 PROMPT_VERSION 递增自动失效旧缓存。
 * @param input - 模型、模式与局面快照。
 * @returns sha256 十六进制键。
 */
export function adviceCacheKey(input: {
  model: string
  coachMode: string
  snapshot: GameSnapshot
}): string {
  const payload = stableStringify({
    model: input.model,
    coachMode: input.coachMode,
    promptVersion: PROMPT_VERSION,
    snapshot: snapshotToContract(input.snapshot),
  })
  return createHash('sha256').update(payload).digest('hex')
}

/** 磁盘建议缓存（一个键一个文件，便于人工检查与清理）。 */
export class AdviceCache {
  private hits = 0
  private misses = 0

  /**
   * @param dir - 缓存目录（不存在时首次写入自动创建）。
   */
  constructor(private readonly dir: string) {}

  /** 命中次数。 */
  get hitCount(): number {
    return this.hits
  }

  /** 未命中次数。 */
  get missCount(): number {
    return this.misses
  }

  /**
   * 读取缓存；缺失或损坏返回 null（按未命中处理）。
   * @param key - 缓存键。
   * @returns 缓存的建议；未命中为 null。
   */
  async get(key: string): Promise<Advice | null> {
    try {
      const raw = await readFile(join(this.dir, `${key}.json`), 'utf-8')
      const parsed = JSON.parse(raw) as { advice?: unknown } | null
      const advice = parsed?.advice
      if (advice === null || advice === undefined || typeof advice !== 'object') {
        this.misses += 1
        return null
      }
      const candidate = advice as Advice
      if (typeof candidate.headline !== 'string') {
        this.misses += 1
        return null
      }
      this.hits += 1
      return candidate
    } catch {
      this.misses += 1
      return null
    }
  }

  /**
   * 写入缓存（原子写）。
   * @param key - 缓存键。
   * @param meta - 模型、模式与回合号。
   * @param advice - 建议本体。
   */
  async put(
    key: string,
    meta: { model: string; coachMode: string; turn: number },
    advice: Advice,
  ): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const entry: AdviceCacheEntry = {
      key,
      model: meta.model,
      coachMode: meta.coachMode,
      turn: meta.turn,
      advice,
      cachedAt: localIsoSeconds(),
    }
    await atomicWriteJson(join(this.dir, `${key}.json`), entry)
  }
}
