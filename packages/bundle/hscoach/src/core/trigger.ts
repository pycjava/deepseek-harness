/**
 * 回合触发器 + 建议发布。
 *
 * 增量检测（正则扫原始行）+ 触发窗口截取（同批后续回合的行不污染快照）
 * + advice.json/game_state.json 原子发布（契约与 Tauri 侧轮询一致）。
 * latest-wins（"新请求覆盖未启动的旧请求"）由引擎层代数计数实现。
 */
import { join } from 'node:path'
import { atomicWriteJson, localIsoSeconds } from './history.ts'
import { isCreateGameLine } from './parser.ts'
import { snapshotToContract, type GameSnapshot } from './state.ts'
import { drawOddsTable } from './probability.ts'

/** 建议输出文件名（advice.json）。 */
export const ADVICE_FILENAME = 'advice.json'
/** 实时快照输出文件名（game_state.json）。 */
export const GAME_STATE_FILENAME = 'game_state.json'
/** Tauri"再想想"按钮写入的触发文件名（插件 watch 该文件的出现）。 */
export const THINK_AGAIN_FILENAME = 'think-again.trigger'

const TURN_RE = /tag=TURN\s+value=(\d+)/
const CURRENT_PLAYER_RE = /Entity=(PlayerOne|PlayerTwo|\d+)\s+tag=CURRENT_PLAYER\s+value=(\d+)/
const PLAYER_ENTITY_RE = /Player EntityID=(\d+) PlayerID=(\d+)/
const NAME_TO_ENTITY_ID: Record<string, number> = { PlayerOne: 2, PlayerTwo: 3 }

/**
 * 回合规则单实现：轮到友方的新回合（turn 递增 + 当前玩家是友方）。
 * @param turn - 本行报告的回合号。
 * @param currentPlayerId - 当前执手玩家 id；未知为 null。
 * @param friendlyPlayerId - 我方玩家 id。
 * @param lastTurn - 此前已见过的最大回合号。
 * @returns 是友方新回合返回 true。
 */
export function isNewFriendlyTurn(
  turn: number,
  currentPlayerId: number | null,
  friendlyPlayerId: number,
  lastTurn: number,
): boolean {
  return currentPlayerId === friendlyPlayerId && turn > lastTurn
}

/**
 * 增量回合检测器：扫描原始行检测 TURN/CURRENT_PLAYER 变化。
 * prefilterFriendly=false 时返回全部新回合（国服中文昵称无法正则预过滤，
 * 由全量解析 + isNewFriendlyTurn 精确过滤）。
 */
export class IncrementalTurnDetector {
  /** 我方玩家 id（回合触发的过滤依据）。 */
  friendlyPlayerId: number
  /** 是否在正则层预过滤友方回合（国服中文昵称需关闭，交给全量解析）。 */
  prefilterFriendly: boolean
  private allLines: string[] = []
  private lastTurn = 0
  private currentPlayer: number | null = null
  private entityToPlayer = new Map<number, number>()
  private triggerUpto = new Map<number, number>()

  constructor(friendlyPlayerId: number, prefilterFriendly = true) {
    this.friendlyPlayerId = friendlyPlayerId
    this.prefilterFriendly = prefilterFriendly
  }

  private resolvePlayerId(token: string): number | null {
    const eid = /^\d+$/.test(token) ? Number(token) : NAME_TO_ENTITY_ID[token]
    /* v8 ignore next -- CURRENT_PLAYER_RE 限定 PlayerOne/PlayerTwo/数字，查表必中 */
    if (eid === undefined) return null
    return this.entityToPlayer.get(eid) ?? eid - 1
  }

  /**
   * 喂入新行，返回本次触发的回合号列表。
   * @param lines - 原始日志行批。
   * @returns 触发的回合号列表。
   */
  feed(lines: string[]): number[] {
    const triggered: number[] = []
    for (const line of lines) {
      this.allLines.push(line)
      if (isCreateGameLine(line)) {
        this.entityToPlayer.clear()
      } else if (line.includes('Player EntityID=')) {
        const m = PLAYER_ENTITY_RE.exec(line)
        /* v8 ignore next -- 失配臂由坏格式行测试行使；分支计数覆盖工具无法归因 */
        if (m) this.entityToPlayer.set(Number(m[1]), Number(m[2]))
      } else if (line.includes('tag=TURN')) {
        const m = TURN_RE.exec(line)
        if (m) {
          const turn = Number(m[1])
          const previousTurn = this.lastTurn
          if (turn > previousTurn) {
            this.lastTurn = turn
            const friendlyTurn = isNewFriendlyTurn(
              turn,
              this.currentPlayer,
              this.friendlyPlayerId,
              previousTurn,
            )
            if (!this.prefilterFriendly || friendlyTurn) {
              this.triggerUpto.set(turn, this.allLines.length)
              triggered.push(turn)
            }
          }
        }
      } else if (line.includes('tag=CURRENT_PLAYER')) {
        const m = CURRENT_PLAYER_RE.exec(line)
        const token = m?.[1]
        if (m && token !== undefined && m[2] === '1') {
          const pid = this.resolvePlayerId(token)
          /* v8 ignore next -- 未知令牌的 null 臂由测试行使；分支计数覆盖工具无法归因 */
          if (pid !== null) this.currentPlayer = pid
        }
      }
    }
    return triggered
  }

  /**
   * 截至指定触发回合（含其 TURN 行）的行流，用于全量解析。
   * @param turn - 触发回合号。
   * @returns 该回合窗口内的原始行数组。
   */
  getTriggerWindow(turn: number): string[] {
    const upto = this.triggerUpto.get(turn) ?? this.allLines.length
    return this.allLines.slice(0, upto)
  }

  /**
   * 全部已喂入的原始行。
   * @returns 行数组引用（随继续喂入增长）。
   */
  getAllLines(): string[] {
    return this.allLines
  }

  /** 清空全部检测状态，回到新对局起点。 */
  reset(): void {
    this.allLines = []
    this.lastTurn = 0
    this.currentPlayer = null
    this.entityToPlayer.clear()
    this.triggerUpto.clear()
  }
}

/** 建议数据契约（advice.json 的 advice 字段）。 */
export interface Advice {
  kind: 'play' | 'trade' | 'pass' | 'uncertain'
  headline: string
  why: string
  steps: string[]
  warning: string
  alternatives: Array<{ headline: string; why: string }>
  latency_ms: number
  degraded: boolean
  lethal: boolean
}

/**
 * 全字段的空建议（降级回显/模型输出归一的基底）。
 * @returns 默认 Advice（kind=uncertain，其余为空值）。
 */
export function emptyAdvice(): Advice {
  return {
    kind: 'uncertain',
    headline: '',
    why: '',
    steps: [],
    warning: '',
    alternatives: [],
    latency_ms: 0,
    degraded: false,
    lethal: false,
  }
}

/**
 * 原子写 advice.json（契约：{turn, timestamp, advice}）。
 * @param publishDir - 发布目录。
 * @param advice - 建议数据。
 * @param turn - 触发回合号。
 * @returns 写入的文件路径。
 */
export async function publishAdvice(
  publishDir: string,
  advice: Advice,
  turn: number,
): Promise<string> {
  const target = join(publishDir, ADVICE_FILENAME)
  await atomicWriteJson(target, {
    turn,
    timestamp: localIsoSeconds(),
    advice,
  })
  return target
}

/**
 * 原子写 game_state.json（实时快照，友方注入抽牌概率参考）。
 * @param publishDir - 发布目录。
 * @param snapshot - 当前对局快照。
 * @param friendlyPlayerId - 我方玩家 id（注入 draw_odds 的目标）。
 * @returns 写入的文件路径。
 */
export async function publishGameState(
  publishDir: string,
  snapshot: GameSnapshot,
  friendlyPlayerId: number,
): Promise<string> {
  const target = join(publishDir, GAME_STATE_FILENAME)
  const contract = snapshotToContract(snapshot)
  const friendly = contract.players[String(friendlyPlayerId)]
  if (friendly && friendly.deck_count > 0) {
    friendly.draw_odds = drawOddsTable(friendly.deck_count)
  }
  await atomicWriteJson(target, {
    turn: contract.turn,
    current_player_id: contract.current_player_id,
    friendly_player_id: friendlyPlayerId,
    timestamp: localIsoSeconds(),
    players: contract.players,
  })
  return target
}
