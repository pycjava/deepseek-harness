/**
 * 教练 prompt：get_system_prompt / build_user_prompt。
 *
 * 十二条铁律与三种教练模式是建议质量与 JSON 契约稳定的根基，改动需谨慎；
 * 改动建议的**语义**（如篇幅铁律）时必须递增 PROMPT_VERSION 使缓存失效。
 */

/**
 * 建议 prompt 语义版本：混入建议缓存键。prompt 措辞微调可不递增；
 * 改变输出风格/字段要求（如篇幅铁律）时必须 +1，否则旧缓存会把旧风格的
 * 建议一直回放给玩家。
 */
export const PROMPT_VERSION = 3

import type { LethalCheck } from '../core/lethal.ts'
import type { SnapshotContract } from '../core/state.ts'
import { drawOddsTable } from '../core/probability.ts'

const CORE_RULES = `规则：
1. 你只看到合法可见信息——不知道对手手牌或牌库的具体内容，请勿猜测。
2. 给出"单一最优解"：一个明确的主推荐动作 + 一句话理由。
3. 如果没有明显最优解（两种打法都合理），kind 设为 "uncertain"，headline 说明两种都行。
4. 必须严格按 JSON 格式输出，字段：kind, headline, why, steps, warning,
   以及可选的 alternatives（仅 uncertain 时建议提供）。
   kind 取值：play（出牌/施法）、trade（交换/解场）、pass（结束回合）、uncertain（无定论）。
   alternatives 格式：[{"headline": "另一打法", "why": "为何也可行/为何次优"}]。
5. 你的建议会显示给玩家参考，由玩家自己操作——你不是在替他打牌。
6. 卡牌效果文本已随局面提供，请以提供的效果为准，不要凭记忆。
7. 只输出最终 JSON，不要在 JSON 前后加任何解释文字。
8. 【斩杀判定】局面里会附一行"伤害评估"，是代码精确计算的本回合确定直接伤害。
   - 标"可斩杀"时：除非有更强赢法，否则推荐执行斩杀，kind 用 "play"。
   - 你不要自行做加法算术（容易算错），直接采信"伤害评估"的数字。
9. 【场面优先】若场面劣势大（对手铺场/有威胁随从），即使有斩杀数字也评估是否需先解场。
10. 【篇幅铁律】建议显示在游戏内悬浮窗，玩家出牌时只有几秒钟浏览：
   - headline：一句话动作指令，≤20 字，开头就说做什么（如"火球术打脸"），不写分析。
   - why：一句话说清核心理由，≤40 字，不展开推演。
   - steps：最多 3 条，每条 ≤15 字，只写操作顺序，不写理由。
   - warning：只在有致命/重大风险时写一句话，否则输出空串。
   - alternatives：最多 1 条，headline 与 why 各一句话。
   宁可少字，不可啰嗦——长篇分析属于对话功能，玩家想听讲解会主动追问。
11. 【资源计数】局面里的"对手已用牌"一行是代码从坟场精确统计的数量，你不要自己数——
   直接采信该计数，结合"牌表上限：非传说 2 张、传说 1 张"判断对手还剩几张关键牌
   （某张卡是不是传说、是否常见于其卡组，由你的卡牌知识判断），据此决定铺场/防解。
12. 【读牌】结合对手职业与已出牌推断其卡组原型与赢法，若影响本回合决策，
   在 why 或 warning 里点出要防的具体牌（如"防 7 费烈焰风暴"）。`

/** 教练模式名 → 模式说明文本的映射。 */
export const COACH_MODES: Record<string, string> = {
  teach:
    '【教学模式】面向学习：篇幅铁律优先——结论照样极简，why 用一句话点出关键原理（如"解场保血，防止下回合被抢死"），不做长篇推演。深度讲解交给对话：玩家想理解时会在聊天里追问，届时再展开。uncertain 时给 1 条 alternatives（headline 与 why 各一句话），让玩家看到权衡。alternatives 字段格式：[{"headline": "...", "why": "..."}]。',
  compete:
    '【竞赛模式】面向天梯快速决策：一切字段从短，headline 即结论，steps 只列必要操作，warning 只写致命风险。简洁、可执行、少字。',
  silent:
    '【静默模式】克制发声：只在斩杀、致命误判、关键抉择时给建议；常规回合若无明显问题，kind 用 pass 且 headline 极简。减少对玩家的干扰。',
}

/** 未指定或未知模式时使用的默认教练模式。 */
export const DEFAULT_COACH_MODE = 'teach'

/** 一条玩家-教练对话轮（由宿主可选提供，注入回合建议的上下文）。 */
export interface ChatTurn {
  role: 'user' | 'coach'
  text: string
}

/**
 * 组装教练 system prompt：核心规则 + 指定模式的说明文本。
 * @param mode - 教练模式名；未传入或不在 COACH_MODES 中时回退 DEFAULT_COACH_MODE。
 * @returns 完整的 system prompt 文本。
 */
export function getSystemPrompt(mode?: string): string {
  const coachMode = mode !== undefined && mode in COACH_MODES ? mode : DEFAULT_COACH_MODE
  /* v8 ignore next -- DEFAULT_COACH_MODE 恒在表中，两重兜底不可达 */
  const modeText = COACH_MODES[coachMode] ?? COACH_MODES[DEFAULT_COACH_MODE] ?? ''
  return (
    '你是一名炉石传说构筑模式的出牌教练。根据给定的对局局面，' +
    '给出这一回合最优的出牌建议。\n\n' +
    CORE_RULES +
    '\n' +
    modeText
  )
}

function formatBoard(cards: SnapshotContract['players'][string]['board']): string[] {
  if (cards.length === 0) return ['  （空场）']
  return cards.map((c) => {
    let atk = `${c.attack}/${c.health}`
    if (c.damaged) atk += `(受伤${c.damaged})`
    const flags = c.flags.length > 0 ? ` [${c.flags.join(', ')}]` : ''
    return `  - ${c.name} ${atk}${flags}`.trimEnd()
  })
}

function fatigueLine(view: SnapshotContract['players'][string], isOpponent: boolean): string | null {
  if (view.deck_count > 0) return null
  const next = view.fatigue + 1
  return isOpponent
    ? `对手牌库已空：其下回合抽牌将受 ${next} 点疲劳伤害。`
    : `牌库已空：下回合抽牌将受 ${next} 点疲劳伤害。`
}

/**
 * 对手已用牌计数行：按 card_id（缺省按名字）从坟场精确统计每张卡的张数。
 * 只报"已见几张"这一确定事实——剩余张数由模型结合"非传说 2 / 传说 1"
 * 上限与卡牌知识判断（铁律 11：计数采信代码，卡牌知识归模型）。
 * @param cards - 对手已出牌（坟场）列表。
 * @returns 计数行文本；无已出牌时为 null。
 */
function usedCardsSummary(cards: SnapshotContract['players'][string]['played_cards']): string | null {
  if (cards.length === 0) return null
  const counts = new Map<string, { name: string; used: number; order: number }>()
  for (const card of cards) {
    const key = card.card_id ?? card.name
    const hit = counts.get(key)
    if (hit !== undefined) hit.used += 1
    else counts.set(key, { name: card.name, used: 1, order: counts.size })
  }
  const parts = [...counts.values()]
    .sort((a, b) => b.used - a.used || a.order - b.order)
    .map(entry => `${entry.name}×${entry.used}`)
  return `【对手已用牌】${parts.join('、')}（牌表上限：非传说 2 张、传说 1 张）`
}

/**
 * 快照 → user prompt（结构化局面文本）。
 * @param contract - 序列化后的对局快照契约。
 * @param friendlyPlayerId - 我方玩家 id（用于区分敌我视角）。
 * @param lethal - 斩杀评估结果；提供时在 prompt 中附"伤害评估"行。
 * @param recentChat - 宿主可选提供的最近玩家-教练对话；提供且非空时
 * 附"最近对话"段，让回合建议延续玩家刚问过的问题。
 * @returns 组装好的 user prompt 文本。
 */
export function buildUserPrompt(
  contract: SnapshotContract,
  friendlyPlayerId: number,
  lethal?: LethalCheck | null,
  recentChat?: readonly ChatTurn[],
): string {
  const players = contract.players
  const friendly = players[String(friendlyPlayerId)] ?? emptyPlayer()
  const opponentId = Object.keys(players)
    .map(Number)
    .find(pid => pid !== friendlyPlayerId)
  const opponent = (opponentId !== undefined ? players[String(opponentId)] : undefined) ?? emptyPlayer()

  const friendlyHand = Array.isArray(friendly.hand) ? friendly.hand : []
  const lines: string[] = [
    `=== 当前回合 ${contract.turn}，轮到玩家 ${friendlyPlayerId} 出牌 ===`,
    '',
    '【我方】',
    `英雄：${friendly.health} 血 ${friendly.armor} 护甲 | 法力 ${friendly.mana}/${friendly.max_mana}`,
    `手牌（${friendlyHand.length}张）：`,
  ]
  for (const c of friendlyHand) {
    const atk = c.attack !== null ? ` ${c.attack}/${c.health}` : ''
    const flags = c.flags.length > 0 ? ` [${c.flags.join(', ')}]` : ''
    lines.push(`  - ${c.name}（${c.cost ?? '?'}费）${atk}${flags} ${c.text}`.trimEnd())
  }

  lines.push('场面：')
  lines.push(...formatBoard(friendly.board))
  lines.push(`牌库剩余：${friendly.deck_count} 张`)
  if (friendly.played_cards.length > 0) {
    lines.push('已出牌：' + friendly.played_cards.map(c => c.name).join('、'))
  }
  const fatigueFriendly = fatigueLine(friendly, false)
  if (fatigueFriendly) lines.push(fatigueFriendly)

  lines.push('', '【对手】')
  lines.push(`英雄：${opponent.health} 血 ${opponent.armor} 护甲`)
  const oppHand = !Array.isArray(opponent.hand) ? opponent.hand : { count: '?' }
  lines.push(`手牌：${oppHand.count} 张（隐藏，不知具体）`)
  lines.push('场面：')
  lines.push(...formatBoard(opponent.board))
  lines.push(`对手牌库剩余：${opponent.deck_count} 张`)
  if (opponent.played_cards.length > 0) {
    lines.push('对手已出牌：' + opponent.played_cards.map(c => c.name).join('、'))
    const usedSummary = usedCardsSummary(opponent.played_cards)
    if (usedSummary !== null) lines.push(usedSummary)
  }
  if (opponent.secrets > 0) {
    const pool = opponent.possible_secrets
    lines.push(
      pool.length > 0
        ? `对手场上奥秘 ${opponent.secrets} 个，可能为：${pool.join('、')}。`
        : `对手场上奥秘 ${opponent.secrets} 个（标准池无此职业奥秘，可能为发现/生成的奥秘）。`,
    )
  }
  const fatigueOpp = fatigueLine(opponent, true)
  if (fatigueOpp) lines.push(fatigueOpp)

  lines.push('')
  if (friendly.deck_count > 0) {
    const odds = drawOddsTable(friendly.deck_count)
    lines.push(
      `【抽牌概率】牌库 ${friendly.deck_count} 张——下回合抽到特定单张` +
        `${Math.round(odds.one_copy_next_draw * 100)}%、两张之一` +
        `${Math.round(odds.two_copy_next_draw * 100)}%。`,
      '',
    )
  }
  if (lethal) {
    lines.push(`【伤害评估】${lethal.summary()}`, '')
  }
  if (recentChat !== undefined && recentChat.length > 0) {
    lines.push('【最近对话】玩家刚与教练聊过，建议延续该语境（但仍只依据上面的局面数据）：')
    for (const turn of recentChat) {
      lines.push(turn.role === 'user' ? `  玩家：${turn.text}` : `  教练：${turn.text}`)
    }
    lines.push('')
  }
  lines.push('请给出这一回合的最优出牌建议（JSON 格式，篇幅从短——玩家只有几秒钟看）。')
  return lines.join('\n')
}

function emptyPlayer(): SnapshotContract['players'][string] {
  return {
    name: '',
    health: 0,
    armor: 0,
    mana: 0,
    max_mana: 10,
    hand: { count: 0 },
    board: [],
    deck_count: 0,
    fatigue: 0,
    played_cards: [],
    secrets: 0,
    possible_secrets: [],
  }
}
