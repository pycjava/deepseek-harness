/**
 * 斩杀/伤害计算器（0-1 背包 + 子集和 DP）。
 *
 * 保守原则不变：只算"确定的直接打脸伤害"（场上攻击 + 手牌直伤法术 +
 * 冲锋随从，受法力预算与嘲讽阻挡模型约束），宁可漏报（LLM 补），
 * 绝不误报（谎报斩杀比漏报致命得多）。
 */
import type { CardView, GameSnapshot } from './state.ts'

const NON_ATTACKING_FLAGS = new Set(['已尽', '冻结', '无法攻击', '休眠'])

/** 可作为攻击来源的实体类型（武器排除：英雄 ATK 已含武器，会翻倍）。 */
const ATTACK_ENTITY_TYPES = new Set(['MINION', 'HERO', ''])

/** 场上随从位上限。 */
export const BOARD_SLOTS = 7

const DAMAGE_SPELL_RE = /造成\s*(\d+)\s*点伤害/
const MINION_ONLY_RE = /对(一个|所有|每个|全部)(敌方)?随从/
const RANDOM_RE = /随机/

/**
 * 从法术文本提取"确定可打脸"的伤害；不确定（随机/只对随从）返回 null。
 * @param text - 卡牌效果文本。
 * @returns 确定的直伤数值；文本为空或伤害不确定时为 null。
 */
export function spellFaceDamage(text: string): number | null {
  if (!text) return null
  if (RANDOM_RE.test(text)) return null
  const m = DAMAGE_SPELL_RE.exec(text)
  if (!m) return null
  const captured = m[1]
  /* v8 ignore next -- 伤害数字是必选捕获组 */
  if (captured === undefined) return null
  const dmg = Number(captured)
  if (dmg <= 0) return null
  if (MINION_ONLY_RE.test(text)) return null
  return dmg
}

interface HandCandidate {
  cost: number
  damage: number
  name: string
  source: 'spell' | 'charge'
  windfury: boolean
}

/** 斩杀评估结果（确定直接伤害、是否可斩杀、嘲讽阻挡与疲劳信息）。 */
export interface LethalCheck {
  availableDamage: number
  lethal: boolean
  detail: Array<{ name: string; damage: number; source: string; windfury?: boolean }>
  deficit: number
  tauntBlocked: boolean
  tauntCost: number
  opponentFatigueDamage: number | null
  /** 一句可读结论（注入 prompt）。 */
  summary(): string
}

function isChargeMinion(c: CardView): boolean {
  if (c.flags.some(f => NON_ATTACKING_FLAGS.has(f))) return false
  return c.flags.includes('冲锋') && (c.attack ?? 0) > 0
}

function collectHandDamageCandidates(hand: CardView[]): HandCandidate[] {
  const candidates: HandCandidate[] = []
  for (const c of hand) {
    const cost = c.cost !== null && c.cost > 0 ? c.cost : 0
    if (c.cardType !== 'MINION') {
      const dmg = c.text ? spellFaceDamage(c.text) : null
      if (dmg !== null && dmg > 0) {
        candidates.push({ cost, damage: dmg, name: c.name || '法术', source: 'spell', windfury: false })
        continue // 同一张卡不重复计
      }
    }
    if (isChargeMinion(c)) {
      const windfury = c.flags.includes('风怒')
      candidates.push({
        cost,
        /* v8 ignore next -- 冲锋候选已过 attack>0 检查，非空 */
        damage: c.attack ?? 0,
        name: c.name || '冲锋随从',
        source: 'charge',
        windfury,
      })
    }
  }
  return candidates
}

/** 手牌伤害候选被选中后的明细（名称、伤害、来源、风怒）。 */
export interface LethalCandidateDetail {
  name: string
  damage: number
  source: HandCandidate['source']
  windfury: boolean
}

/**
 * 0-1 背包：法力预算内伤害总和最大（0 费候选必选，不占预算）。
 * @param candidates - 手牌伤害候选列表。
 * @param manaBudget - 本回合可用法力预算。
 * @returns [最大伤害总和, 选中候选的明细列表]。
 */
export function knapsackPick(
  candidates: HandCandidate[],
  manaBudget: number,
): [number, LethalCandidateDetail[]] {
  const detail = (c: HandCandidate): LethalCandidateDetail => ({
    name: c.name,
    damage: c.damage,
    source: c.source,
    windfury: c.windfury,
  })
  if (candidates.length === 0) {
    return [0, []]
  }
  if (manaBudget <= 0) {
    const zero = candidates.filter(c => c.cost === 0)
    return [zero.reduce((sum, c) => sum + c.damage, 0), zero.map(detail)]
  }

  const zeroCost = candidates.filter(c => c.cost === 0)
  const items = candidates.filter(c => c.cost > 0 && c.cost <= manaBudget)

  // dp[j] = [最大伤害, 选中列表]；逆序更新的标准 0-1 背包
  const dp: Array<[number, HandCandidate[]]> = Array.from({ length: manaBudget + 1 }, () => [0, []])
  for (const c of items) {
    const next = dp.map(x => x)
    for (let j = manaBudget; j >= c.cost; j--) {
      const prev = dp[j - c.cost]
      const current = dp[j]
      /* v8 ignore next -- 循环边界保证两个下标都在表内 */
      if (prev === undefined || current === undefined) continue
      const candDmg = prev[0] + c.damage
      if (candDmg > current[0]) next[j] = [candDmg, [...prev[1], c]]
    }
    for (let j = 0; j <= manaBudget; j++) {
      const value = next[j]
      /* v8 ignore next -- next 与 dp 同长，元素必存在 */
      if (value !== undefined) dp[j] = value
    }
  }
  let best: [number, HandCandidate[]] = [0, []]
  for (const entry of dp) if (entry[0] > best[0]) best = entry

  const chosen = [...best[1], ...zeroCost]
  return [chosen.reduce((sum, c) => sum + c.damage, 0), chosen.map(detail)]
}

function boardMinionCount(board: CardView[]): number {
  let count = 0
  for (const c of board) {
    // An empty cardType with health still occupies a slot (unnamed entities).
    if (c.cardType === 'MINION' || (!c.cardType && c.health !== null)) count += 1
  }
  return count
}

interface Entry {
  damage: number
  name: string
  source: 'board' | 'charge' | 'spell'
}

/**
 * 子集和 DP：选条目子集使 sum ≥ requiredSum 且条目数 ≥ requiredCount，
 * sum 最小（清嘲讽的最小伤害）。不可行返回 null。
 * @param entries - 可支配的伤害条目。
 * @param requiredSum - 子集伤害和下限（嘲讽总血量 + 圣盾层数）。
 * @param requiredCount - 子集条目数下限（嘲讽数 + 圣盾层数）。
 * @returns 达标的最小子集 `{ cost, used }`（used 为选中条目下标）；不可行为 null。
 */
export function minClearSubset(
  entries: Entry[],
  requiredSum: number,
  requiredCount: number,
): { cost: number; used: number[] } | null {
  const n = entries.length
  if (n === 0 || requiredCount > n) return null
  const maxNeed = requiredSum + Math.max(...entries.map(e => e.damage))
  // dp[k][s] = 选中下标元组（null 不可达）
  const dp: Array<Array<Int32Array | null>> = Array.from({ length: n + 1 }, () =>
    Array.from({ length: maxNeed + 1 }, () => null),
  )
  const dp0 = dp[0]
  /* v8 ignore next -- dp 至少含一行 */
  if (dp0 !== undefined) dp0[0] = new Int32Array(0)
  for (let idx = 0; idx < n; idx++) {
    const entry = entries[idx]
    /* v8 ignore next -- idx 受数组长度约束 */
    if (entry === undefined) continue
    const dmg = entry.damage
    for (let k = n - 1; k >= 0; k--) {
      for (let s = maxNeed - dmg; s >= 0; s--) {
        const prev = dp[k]?.[s]
        const target = dp[k + 1]
        if (!prev || prev.includes(idx) || target === undefined) continue
        if (target[s + dmg] === null) {
          target[s + dmg] = new Int32Array([...prev, idx])
        }
      }
    }
  }
  for (let s = requiredSum; s <= maxNeed; s++) {
    for (let k = requiredCount; k <= n; k++) {
      const v = dp[k]?.[s]
      if (v) return { cost: s, used: [...v] }
    }
  }
  return null
}

/** 嘲讽阻挡模型：(打脸伤害, 清嘲讽花费, 攻击是否被挡, 打脸明细)。 */
function resolveFace(
  attackEntries: Entry[],
  spellEntries: Entry[],
  taunts: CardView[],
): [number, number, boolean, Array<{ name: string; damage: number; source: string }>] {
  const allEntries = [...attackEntries, ...spellEntries]
  const total = allEntries.reduce((sum, e) => sum + e.damage, 0)
  const asDetail = (list: Entry[]) => list.map(e => ({ name: e.name, damage: e.damage, source: e.source }))
  if (taunts.length === 0) {
    return [total, 0, false, asDetail(allEntries)]
  }
  const spellTotal = spellEntries.reduce((sum, e) => sum + e.damage, 0)
  const spellDetail = asDetail(spellEntries)
  const tauntHp = taunts.reduce((sum, t) => sum + (t.health ?? 0), 0)
  // 免疫嘲讽清不掉 → 攻击永远被挡，法术照常打脸
  if (taunts.some(t => t.flags.includes('免疫'))) {
    return [spellTotal, 0, true, spellDetail]
  }
  // 圣盾：每层多吸收一次攻击
  const dsCount = taunts.filter(t => t.flags.includes('圣盾')).length
  const cleared = minClearSubset(allEntries, tauntHp + dsCount, taunts.length + dsCount)
  if (!cleared) {
    return [spellTotal, 0, true, spellDetail]
  }
  const clearFace = total - cleared.cost
  // 法术全打脸 ≥ 清嘲讽后的打脸 → 不征用法术清嘲讽
  if (spellTotal > clearFace) {
    return [spellTotal, 0, true, spellDetail]
  }
  const usedSet = new Set(cleared.used)
  const faceDetail = allEntries.filter((_, i) => !usedSet.has(i)).map(e => ({
    name: e.name,
    damage: e.damage,
    source: e.source,
  }))
  return [clearFace, cleared.cost, false, faceDetail]
}

/**
 * 计算本回合友方对对手的确定打脸伤害与斩杀判定。
 * @param snapshot - 当前对局快照。
 * @param friendlyPlayerId - 我方玩家 id；非我方回合返回空评估。
 * @returns 斩杀评估结果（summary 已注入可读结论）。
 */
export function computeLethal(snapshot: GameSnapshot, friendlyPlayerId = 1): LethalCheck {
  const empty: LethalCheck = {
    availableDamage: 0,
    lethal: false,
    detail: [],
    deficit: 0,
    tauntBlocked: false,
    tauntCost: 0,
    opponentFatigueDamage: null,
    /* v8 ignore next -- 空结论的占位 summary 立即被 withSummary 替换 */
    summary: () => '',
  }
  if (snapshot.currentPlayerId !== friendlyPlayerId) {
    return withSummary(empty)
  }
  const friendly = snapshot.players[String(friendlyPlayerId)]
  const opponentEntry = Object.entries(snapshot.players).find(
    ([pid]) => Number(pid) !== friendlyPlayerId,
  )
  if (!friendly || !opponentEntry) return withSummary(empty)
  const opponent = opponentEntry[1]

  // 场上攻击条目（风怒两条）
  const attackEntries: Entry[] = []
  for (const c of friendly.board) {
    if (c.cardType !== null && !ATTACK_ENTITY_TYPES.has(c.cardType)) continue
    if (c.flags.some(f => NON_ATTACKING_FLAGS.has(f))) continue
    const atk = c.attack ?? 0
    if (atk > 0) {
      attackEntries.push({ damage: atk, name: c.name || '随从', source: 'board' })
      if (c.flags.includes('风怒')) {
        attackEntries.push({ damage: atk, name: c.name || '随从', source: 'board' })
      }
    }
  }

  // 手牌伤害（背包）+ 随从位约束
  const manaBudget = friendly.mana
  const hand = Array.isArray(friendly.hand) ? friendly.hand : []
  let candidates = collectHandDamageCandidates(hand)
  const slots = BOARD_SLOTS - boardMinionCount(friendly.board)
  if (slots <= 0) {
    candidates = candidates.filter(c => c.source !== 'charge')
  } else {
    const chargeCands = candidates
      .filter(c => c.source === 'charge')
      .sort((a, b) => b.damage - a.damage)
      .slice(0, slots)
    candidates = [...candidates.filter(c => c.source !== 'charge'), ...chargeCands]
  }
  const [, handDetail] = knapsackPick(candidates, manaBudget)
  const spellEntries: Entry[] = []
  for (const d of handDetail) {
    const entry: Entry = { damage: d.damage, name: d.name, source: d.source }
    if (d.source === 'charge') {
      attackEntries.push(entry)
      if (d.windfury) attackEntries.push(entry)
    } else {
      spellEntries.push(entry)
    }
  }

  const taunts = opponent.board.filter(c => c.flags.includes('嘲讽'))
  const [face, clearCost, blocked, faceDetail] = resolveFace(attackEntries, spellEntries, taunts)

  const oppHp = opponent.health + opponent.armor
  const lethal = face >= oppHp && face > 0
  const deficit = Math.max(0, oppHp - face)
  const fatigueDamage = opponent.deckCount <= 0 ? opponent.fatigue + 1 : null

  return withSummary({
    availableDamage: face,
    lethal,
    detail: faceDetail,
    deficit,
    tauntBlocked: blocked,
    tauntCost: clearCost,
    opponentFatigueDamage: fatigueDamage,
    /* v8 ignore next -- 占位 summary 立即被 withSummary 替换 */
    summary: () => '',
  })
}

function withSummary(check: LethalCheck): LethalCheck {
  const base = { ...check }
  base.summary = () => lethalSummary(base)
  return base
}

function lethalSummary(check: LethalCheck): string {
  let text: string
  if (check.availableDamage === 0) {
    return check.tauntBlocked
      ? '本回合无确定打脸伤害（对手嘲讽阻挡，且无可用法术伤害）。'
      : '本回合无确定直接伤害（场攻 0）。'
  }
  const sources = check.detail.map(d => `${d.name}(${d.damage})`).join('、')
  if (check.lethal) {
    text = `⚠ 本回合可斩杀：确定直接伤害共 ${check.availableDamage}（${sources}）。`
  } else {
    text = `本回合确定直接伤害 ${check.availableDamage}（${sources}），距斩杀还差 ${check.deficit}。`
  }
  if (check.tauntBlocked) {
    text += '注意：对手嘲讽未清光，随从/英雄攻击无法打脸（以上仅法术伤害）。'
  } else if (check.tauntCost > 0) {
    text += `（其中清除嘲讽花费 ${check.tauntCost} 点伤害）`
  }
  if (check.opponentFatigueDamage) {
    text += `对手牌库已空：其下回合抽牌将受 ${check.opponentFatigueDamage} 点疲劳伤害。`
  }
  return text
}
