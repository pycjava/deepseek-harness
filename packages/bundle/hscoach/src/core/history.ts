/**
 * 对局结果与战绩统计。
 *
 * PLAYSTATE 终局值写在玩家实体上（PlayerOne/PlayerTwo/数字 id/国服昵称），
 * 按友方实体取值；每局只记一次；history.jsonl 追加 + stats.json 原子重写。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isCreateGameLine } from './parser.ts'

/** 对局历史文件名（JSONL 追加）。 */
export const HISTORY_FILENAME = 'history.jsonl'
/** 战绩统计文件名（原子重写）。 */
export const STATS_FILENAME = 'stats.json'

type Result = 'win' | 'loss' | 'tie'

const RESULT_MAP: Record<string, Result> = { WON: 'win', LOST: 'loss', TIED: 'tie' }

const PLAYSTATE_RE = /Entity=(\S+)\s+tag=PLAYSTATE\s+value=(\w+)/
const PLAYER_ENTITY_RE = /Player EntityID=(\d+)\s+PlayerID=(\d+)/
const PLAYER_NAME_RE = /PlayerID=(\d+),\s*PlayerName=(\S+)/
const NAME_TO_ENTITY_ID: Record<string, number> = { PlayerOne: 2, PlayerTwo: 3 }

/** 聚合战绩统计。 */
export interface HistoryStats {
  total: number
  wins: number
  losses: number
  ties: number
  winrate_pct: number
}

/** 从原始日志行检测友方终局结果（正则，极快）。 */
export class GameResultDetector {
  /** 友方玩家 id（终局结果按此过滤）。 */
  friendlyPlayerId: number
  private fired = false
  private entityToPlayer = new Map<number, number>()
  private nameToPlayer = new Map<string, number>()

  constructor(friendlyPlayerId = 1) {
    this.friendlyPlayerId = friendlyPlayerId
  }

  /**
   * 喂入原始行，返回本次检测到的友方终局结果列表。
   * @param lines - 原始日志行批。
   * @returns 本次喂入触发 detection 的友方终局结果（通常至多一个）。
   */
  feed(lines: string[]): Result[] {
    const results: Result[] = []
    for (const line of lines) {
      if (isCreateGameLine(line)) {
        // 只认 GameState.DebugPrintPower 的 CREATE_GAME（国服 PowerTaskList
        // 重复行不是边界，否则刚建的映射被误清）
        this.fired = false
        this.entityToPlayer.clear()
        this.nameToPlayer.clear()
        continue
      }
      if (line.includes('Player EntityID=')) {
        const m = PLAYER_ENTITY_RE.exec(line)
        if (m) this.entityToPlayer.set(Number(m[1]), Number(m[2]))
        continue
      }
      if (line.includes('PlayerName=')) {
        const m = PLAYER_NAME_RE.exec(line)
        const name = m?.[2]
        if (m && name !== undefined) this.nameToPlayer.set(name, Number(m[1]))
        continue
      }
      if (this.fired || !line.includes('tag=PLAYSTATE')) continue
      const m = PLAYSTATE_RE.exec(line)
      if (!m) continue
      const token = m[1]
      const value = m[2]
      /* v8 ignore next -- PLAYSTATE_RE 的两个捕获组为必选，命中即存在 */
      if (token === undefined || value === undefined) continue
      const mapped = RESULT_MAP[value]
      if (!mapped) continue // PLAYING/WINNING/LOSING 非终局
      const pid = this.resolvePlayerId(token)
      if (pid === null || pid !== this.friendlyPlayerId) continue
      this.fired = true
      results.push(mapped)
    }
    return results
  }

  private resolvePlayerId(token: string): number | null {
    const byName = this.nameToPlayer.get(token)
    if (byName !== undefined) return byName
    let eid: number
    if (/^\d+$/.test(token)) {
      eid = Number(token)
    } else {
      const mapped = NAME_TO_ENTITY_ID[token]
      if (mapped === undefined) return null
      eid = mapped
    }
    return this.entityToPlayer.get(eid) ?? eid - 1
  }

  /** 清空检测状态（终局标记与玩家映射），回到新对局起点。 */
  reset(): void {
    this.fired = false
    this.entityToPlayer.clear()
    this.nameToPlayer.clear()
  }
}

/** history.jsonl 中的一局记录。 */
export interface HistoryEntry {
  timestamp: string
  result: Result
  friendly_class: string
  opponent_class: string
  turns: number
}

/**
 * 本地时间 ISO（秒精度，无时区后缀）。
 * @param date - 要格式化的时间；缺省为当前时间。
 * @returns 形如 `YYYY-MM-DDTHH:mm:ss` 的本地时间字符串。
 */
export function localIsoSeconds(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 记录一局：追加 history.jsonl + 原子重写 stats.json，返回聚合战绩。
 * @param publishDir - 战绩文件所在目录（不存在时创建）。
 * @param result - 终局结果。
 * @param friendlyClass - 我方职业；空值记为"未知"。
 * @param opponentClass - 对手职业；空值记为"未知"。
 * @param turns - 对局回合数。
 * @returns 重写后的聚合战绩。
 */
export async function recordResult(
  publishDir: string,
  result: Result,
  friendlyClass: string,
  opponentClass: string,
  turns: number,
): Promise<HistoryStats> {
  await mkdir(publishDir, { recursive: true })
  const entry: HistoryEntry = {
    timestamp: localIsoSeconds(),
    result,
    friendly_class: friendlyClass || '未知',
    opponent_class: opponentClass || '未知',
    turns,
  }
  const historyPath = join(publishDir, HISTORY_FILENAME)
  await appendFile(historyPath, JSON.stringify(entry) + '\n', 'utf-8')
  const stats = await aggregate(historyPath)
  await atomicWriteJson(join(publishDir, STATS_FILENAME), stats)
  return stats
}

/**
 * 从 history.jsonl 聚合战绩；缺失/损坏返回空战绩。
 * @param historyPath - history.jsonl 文件路径。
 * @returns 聚合后的战绩统计。
 */
export async function aggregate(historyPath: string): Promise<HistoryStats> {
  const stats: HistoryStats = { total: 0, wins: 0, losses: 0, ties: 0, winrate_pct: 0 }
  if (!existsSync(historyPath)) return stats
  let text: string
  try {
    text = await readFile(historyPath, 'utf-8')
  } catch {
    return stats
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let entry: { result?: string }
    try {
      entry = JSON.parse(line) as { result?: string }
    } catch {
      continue // 容忍损坏行
    }
    stats.total += 1
    if (entry.result === 'win') stats.wins += 1
    else if (entry.result === 'loss') stats.losses += 1
    else stats.ties += 1
  }
  if (stats.total) {
    stats.winrate_pct = Math.round((stats.wins / stats.total) * 1000) / 10
  }
  return stats
}

/**
 * 原子写 JSON（tmp + rename，读者永不看到半写状态）。
 * @param path - 目标文件路径。
 * @param payload - 要序列化写入的 JSON 值。
 */
export async function atomicWriteJson(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
  await rename(tmp, path)
}
