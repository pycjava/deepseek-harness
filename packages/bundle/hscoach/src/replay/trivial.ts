/**
 * 琐碎回合判定（保守规则，非打法库）。
 *
 * 设计立场：这里**不预置任何"该怎么打"的策略**——炉石的难点在评估而不在
 * 枚举，规则化的打法库会带来系统性的错误建议与无休止的维护。本模块只回答
 * 一个更弱的问题："这一回合还有没有任何可执行动作？" 只有在**确实无动作
 * 可做**（无斩杀、无可用手牌、无攻击频率、英雄技能也不可用）时才跳过 LLM，
 * 用规则建议占位。判不准一律不跳过，宁多花一次调用，不漏关键回合。
 */
import type { LethalCheck } from '../core/lethal.ts'
import type { GameSnapshot, PlayerView } from '../core/state.ts'
import type { Advice } from '../core/trigger.ts'

/** 使随从丧失攻击频率的标记。 */
const NO_ATTACK_FLAGS = ['已尽', '无法攻击', '冻结']

/** 取友方视图；缺席返回 null。 */
function friendlyView(snapshot: GameSnapshot, friendlyPlayerId: number): PlayerView | null {
  return snapshot.players[String(friendlyPlayerId)] ?? null
}

/**
 * 本回合是否存在任何可执行动作（保守：判不准即视为有动作）。
 * @param snapshot - 当前局面快照。
 * @param friendlyPlayerId - 我方玩家 id。
 * @param lethal - 斩杀求解结果（null = 未计算，按无斩杀处理）。
 * @returns 有可执行动作返回 true。
 */
export function hasAvailableAction(
  snapshot: GameSnapshot,
  friendlyPlayerId: number,
  lethal: LethalCheck | null,
): boolean {
  if (lethal?.lethal === true) return true
  const view = friendlyView(snapshot, friendlyPlayerId)
  if (view === null) return true
  // 手牌不可见（对手视角）或非列表：判不准，按有动作处理
  if (!Array.isArray(view.hand)) return true
  const mana = view.mana
  // 成本未知的手牌按可出处理（保守）
  const affordableCard = view.hand.some(card => card.cost === null || card.cost <= mana)
  if (affordableCard) return true
  const minions = view.board.filter(card => card.cardType === 'MINION')
  const canAttack = minions.some(
    minion =>
      (minion.attack ?? 0) > 0 && !minion.flags.some(flag => NO_ATTACK_FLAGS.includes(flag)),
  )
  if (canAttack) return true
  const heroPower = view.board.find(card => card.cardType === 'HERO_POWER')
  if (heroPower !== undefined) {
    const usable = !heroPower.flags.includes('已尽') && (heroPower.cost ?? 99) <= mana
    if (usable) return true
  }
  return false
}

/**
 * 是否琐碎回合（可跳过 LLM）。
 * @param snapshot - 当前局面快照。
 * @param friendlyPlayerId - 我方玩家 id。
 * @param lethal - 斩杀求解结果。
 * @returns 无任何可执行动作返回 true。
 */
export function isTrivialTurn(
  snapshot: GameSnapshot,
  friendlyPlayerId: number,
  lethal: LethalCheck | null,
): boolean {
  return !hasAvailableAction(snapshot, friendlyPlayerId, lethal)
}

/**
 * 琐碎回合的规则建议（不调用 LLM，字段满足发布契约）。
 * @param turn - 当前回合号。
 * @returns 契约完整的占位建议。
 */
export function trivialAdvice(turn: number): Advice {
  return {
    kind: 'pass',
    headline: '无牌可出、无攻击频率、英雄技能也不可用——结束回合',
    why: `规则判定（未调用模型）：第 ${turn} 回合没有任何可执行动作，等待对手行动。`,
    steps: ['结束回合'],
    warning: '',
    alternatives: [],
    latency_ms: 0,
    degraded: false,
    lethal: false,
  }
}

/**
 * 快进跳过回合的规则建议（不调用 LLM，仅用于占位发布）。
 * @param turn - 当前回合号。
 * @returns 契约完整的占位建议。
 */
export function fastForwardAdvice(turn: number): Advice {
  return {
    kind: 'uncertain',
    headline: `快进跳过（第 ${turn} 回合未执教）`,
    why: '快进区间不生成建议：跳过这些回合以节省调用，到达目标回合后恢复逐回合执教。',
    steps: [],
    warning: '',
    alternatives: [],
    latency_ms: 0,
    degraded: false,
    lethal: false,
  }
}
