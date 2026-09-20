/**
 * 重放切批：把整份 Power.log 切成「对局 → 回合」两层批次。
 *
 * 为什么需要它：引擎的建议生成是 latest-wins（新回合到达即作废旧请求），
 * 把整份日志一次性灌进去只会产出最后一个回合的建议（实测：一局 15+ 回合
 * 只出 1 条）。按回合切批 + 逐批等待，才能让每个回合都真正拿到建议。
 *
 * 切批只依赖 `tag=TURN` 的回合号递增（与 IncrementalTurnDetector 同一判据），
 * 因此 GameState / PowerTaskList 的重复行不会切出多余批次。
 */
import { isCreateGameLine } from '../core/parser.ts'

const TURN_RE = /tag=TURN\s+value=(\d+)/

/** 一个重放批次：从某回合的 TURN 声明行开始的一段原始日志行。 */
export interface ReplaySegment {
  /** 批次起始回合号；开局准备阶段（CREATE_GAME 到首个 TURN 行）为 0。 */
  turn: number
  /** 该批次的原始行（顺序喂给引擎即可）。 */
  lines: string[]
}

/** 一份日志中的一局及其回合批次。 */
export interface ReplayGamePlan {
  /** 0 基对局序号（与日志中 CREATE_GAME 的出现顺序一致）。 */
  index: number
  /** 参与重放的批次总数（含准备阶段）。 */
  segmentCount: number
  /** 按回合切好的批次，顺序喂入。 */
  segments: ReplaySegment[]
}

/**
 * 把一份日志切成"对局 → 回合批次"的计划。
 *
 * 无 CREATE_GAME 的日志（截断/异常）整体当作一个对局，准备阶段从第 0 行起，
 * 保证调用方永远能拿到可喂入的批次。
 * @param lines - 日志行数组。
 * @returns 各局的重放计划（按日志顺序）。
 */
export function planReplay(lines: readonly string[]): ReplayGamePlan[] {
  const starts: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    /* v8 ignore next -- 索引在界内，undefined 臂不可达 */
    if (line !== undefined && isCreateGameLine(line)) starts.push(i)
  }
  if (starts.length === 0) starts.push(0)
  return starts.map((from, g) => {
    const to = g + 1 < starts.length ? (starts[g + 1] ?? lines.length) : lines.length
    return buildGame(g, lines, from, to)
  })
}

/** 单局切批：回合号递增处开新批次。 */
function buildGame(index: number, lines: readonly string[], from: number, to: number): ReplayGamePlan {
  const segments: ReplaySegment[] = []
  let current: string[] = []
  let currentTurn = 0
  let maxTurn = 0
  for (let i = from; i < to; i += 1) {
    const line = lines[i]
    /* v8 ignore next -- 索引在界内，undefined 臂不可达 */
    if (line === undefined) continue
    const matched = line.includes('tag=TURN') ? TURN_RE.exec(line) : null
    const turn = matched === null ? null : Number(matched[1])
    if (turn !== null && turn > maxTurn) {
      if (current.length > 0) segments.push({ turn: currentTurn, lines: current })
      current = []
      maxTurn = turn
      currentTurn = turn
    }
    current.push(line)
  }
  if (current.length > 0) segments.push({ turn: currentTurn, lines: current })
  return { index, segmentCount: segments.length, segments }
}
