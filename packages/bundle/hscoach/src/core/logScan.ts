/**
 * 日志会话扫描：列出可复盘的历史对局。
 *
 * 与实时 tail 的区别：这里是**离线**读取（整份文件读完就关），不碰单实例锁、
 * 不写发布目录，只产出"有哪些局可以重放"的目录信息。解析复用实时管线的
 * 同一套 parsePowerLog / serializeGame / calibrateFriendlyPlayer，
 * 因此选局界面看到的信息与教练实际会看到的一致。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isCreateGameLine, parsePowerLog } from './parser.ts'
import { GameResultDetector } from './history.ts'
import { calibrateFriendlyPlayer, serializeGame } from './state.ts'

/** 日志目录下的单局摘要（选局用）。 */
export interface ScannedGame {
  /** 0 基对局序号（与日志里 CREATE_GAME 的出现顺序一致）。 */
  gameIndex: number
  /** 该局最大回合号。 */
  turns: number
  /** 终局结果；日志未记录终局时为 unknown。 */
  result: 'win' | 'loss' | 'tie' | 'unknown'
  /** 我方职业（英文枚举，未知为 unknown）。 */
  friendlyClass: string
  /** 对手职业（英文枚举，未知为 unknown）。 */
  opponentClass: string
  /** 我方玩家名（可能带 #tag）。 */
  friendlyName: string
  /** 对手玩家名。 */
  opponentName: string
  /** 该局首行时间（HH:MM:SS），取不到为 null。 */
  startedAt: string | null
  /** 该局末行时间（HH:MM:SS），取不到为 null。 */
  endedAt: string | null
}

/** 一个日志会话（Logs/<时间戳>/ 目录）的扫描结果。 */
export interface ScannedSession {
  /** 会话目录绝对路径。 */
  sessionDir: string
  /** Power.log 绝对路径（重放入口）。 */
  logPath: string
  /** 目录名里的时间戳（Hearthstone_YYYY_MM_DD_HH_MM_SS），解析失败为 null。 */
  sessionStamp: string | null
  /** 文件大小（字节）。 */
  sizeBytes: number
  /** 文件最后修改时间（ISO 秒）。 */
  modifiedAt: string
  /** 该会话内的对局（按时间顺序）。 */
  games: ScannedGame[]
}

/** HERO_XX → 职业英文枚举（与卡库 cardClass 同名）。 */
const HERO_CLASS: Record<string, string> = {
  HERO_01: 'WARRIOR',
  HERO_02: 'SHAMAN',
  HERO_03: 'ROGUE',
  HERO_04: 'PALADIN',
  HERO_05: 'HUNTER',
  HERO_06: 'DRUID',
  HERO_07: 'WARLOCK',
  HERO_08: 'MAGE',
  HERO_09: 'PRIEST',
  HERO_10: 'DEMONHUNTER',
  HERO_11: 'DEATHKNIGHT',
}

/** 行首时间戳（`D HH:MM:SS.fffffff ...`）。 */
const LINE_STAMP_RE = /^[A-Z] (\d{2}:\d{2}:\d{2})\.\d+/
/** 会话目录名时间戳。 */
const SESSION_DIR_RE = /^Hearthstone_(\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2})$/
/** 玩家名注册行：`PlayerID=1, PlayerName=堕落#53392`（用于展示双方名字）。 */
const PLAYER_NAME_RE = /PlayerID=(\d+), PlayerName=(.+)$/

/** 职业枚举：hero cardId → 英文职业名（取不到为 unknown）。 */
function heroClass(cardId: string | null | undefined): string {
  if (!cardId) return 'unknown'
  return HERO_CLASS[cardId] ?? 'unknown'
}

/** 单局摘要：解析该局行窗口内的终局与时间戳。 */
function summarizeGame(
  gameIndex: number,
  games: ReturnType<typeof parsePowerLog>['games'],
  window: readonly string[],
): ScannedGame {
  const model = games[gameIndex]
  let turns = 0
  let friendlyClass = 'unknown'
  let opponentClass = 'unknown'
  let friendlyName = ''
  let opponentName = ''
  let friendlyId: number | null = null
  if (model !== undefined) {
    friendlyId = calibrateFriendlyPlayer(model)
    /* v8 ignore next -- 校准失败（无玩家实体）的对局由测试桩行使；序列化仍会给出玩家视图 */
    const pid = friendlyId ?? 1
    try {
      const snapshot = serializeGame(model, pid, null)
      turns = snapshot.turn
      const friendly = snapshot.players[String(pid)]
      friendlyName = friendly?.name ?? ''
      friendlyClass = heroClass(friendly?.hero?.cardId)
      const opponentId = Object.keys(snapshot.players).map(Number).find(id => id !== pid)
      const opponent = opponentId === undefined ? undefined : snapshot.players[String(opponentId)]
      opponentName = opponent?.name ?? ''
      opponentClass = heroClass(opponent?.hero?.cardId)
    } catch {
      // 隐藏信息违规等：只保留能拿到的信息（turns 保持 0）
    }
  }

  let result: ScannedGame['result'] = 'unknown'
  // 玩家名：终局行与快照里的名字可能不同（快照会兜底成 "玩家1"），
  // 用日志自己的 `PlayerID=n, PlayerName=…` 注册行给出可读的双方名字。
  for (const line of window) {
    const named = PLAYER_NAME_RE.exec(line)
    if (!named) continue
    const pid = Number(named[1])
    const name = (named[2] ?? '').trim()
    if (name.length === 0) continue
    if (pid === (friendlyId ?? 1)) friendlyName = name
    else opponentName = name
  }
  // 胜负复用实时管线同一套终局检测器（名字→玩家 id 映射、每局只记一次）
  const detector = new GameResultDetector(friendlyId ?? 1)
  const results = detector.feed([...window])
  const detected = results[results.length - 1]
  if (detected !== undefined) result = detected

  const stamps = window.map(line => LINE_STAMP_RE.exec(line)?.[1]).filter((s): s is string => s !== undefined)
  return {
    gameIndex,
    turns,
    result,
    friendlyClass,
    opponentClass,
    friendlyName,
    opponentName,
    startedAt: stamps[0] ?? null,
    endedAt: stamps[stamps.length - 1] ?? null,
  }
}

/**
 * 扫描一个 Power.log，按 CREATE_GAME 边界切出对局摘要。
 * @param logPath - Power.log 绝对路径。
 * @param sessionDir - 该日志所在会话目录（结果里回填）。
 * @param sizeBytes - 文件大小（调用方已 stat 时避免重复 stat）。
 * @param modifiedAt - 文件修改时间（ISO 秒）。
 * @returns 会话扫描结果；无对局时 games 为空数组。
 */
export async function scanPowerLog(
  logPath: string,
  sessionDir: string,
  sizeBytes: number,
  modifiedAt: string,
): Promise<ScannedSession> {
  const text = await readFile(logPath, 'utf-8')
  const lines = text.split(/\r?\n/)
  const starts: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /* v8 ignore next -- split 不产生 undefined；索引安全守卫 */
    if (line !== undefined && isCreateGameLine(line)) starts.push(i)
  }
  const parsed = parsePowerLog(lines)
  const games: ScannedGame[] = []
  for (let g = 0; g < starts.length; g += 1) {
    const from = starts[g]
    /* v8 ignore next -- 循环上界保证 starts[g] 存在 */
    if (from === undefined) continue
    const to = g + 1 < starts.length ? (starts[g + 1] ?? lines.length) : lines.length
    games.push(summarizeGame(g, parsed.games, lines.slice(from, to)))
  }
  const dirName = sessionDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  return {
    sessionDir,
    logPath,
    sessionStamp: SESSION_DIR_RE.exec(dirName)?.[1] ?? null,
    sizeBytes,
    modifiedAt,
    games,
  }
}

/** 会话排序：时间戳新的在前，缺时间戳的排最后。 */
function compareSessions(a: ScannedSession, b: ScannedSession): number {
  if (a.sessionStamp === b.sessionStamp) return 0
  if (a.sessionStamp === null) return 1
  if (b.sessionStamp === null) return -1
  return a.sessionStamp < b.sessionStamp ? 1 : -1
}

/**
 * 扫描炉石 Logs 根目录下所有含 Power.log 的会话（新的在前）。
 * @param logsRoot - Logs 根目录（如 `<安装目录>/Logs`）。
 * @returns 会话列表；目录不存在时为 []。
 */
export async function scanLogSessions(logsRoot: string): Promise<ScannedSession[]> {
  if (!existsSync(logsRoot)) return []
  const entries = await readdir(logsRoot, { withFileTypes: true })
  const sessions: ScannedSession[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(logsRoot, entry.name)
    const logPath = join(dir, 'Power.log')
    if (!existsSync(logPath)) continue
    const info = await stat(logPath)
    sessions.push(
      await scanPowerLog(logPath, dir, info.size, info.mtime.toISOString().slice(0, 19)),
    )
  }
  sessions.sort(compareSessions)
  return sessions
}
