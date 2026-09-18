/**
 * 斩杀/伤害计算单元测试：直伤法术识别、0-1 背包、清嘲讽子集和、
 * 打脸阻挡模型与各保守分支。
 */
import { describe, expect, it } from 'vitest'
import type { CardView } from '../src/core/state.ts'
import type { GameSnapshot, PlayerView } from '../src/core/state.ts'
import {
  BOARD_SLOTS,
  computeLethal,
  knapsackPick,
  minClearSubset,
  spellFaceDamage,
  type LethalCandidateDetail,
} from '../src/core/lethal.ts'

function handCard(overrides: Partial<CardView> = {}): CardView {
  return {
    cardId: 'X',
    name: '卡',
    cost: 1,
    attack: null,
    health: null,
    flags: [],
    text: '',
    damaged: null,
    cardType: 'SPELL',
    cardClass: 'NEUTRAL',
    ...overrides,
  }
}

function minionBoardCard(attack: number, health: number, flags: string[] = []): CardView {
  return handCard({
    attack,
    health,
    flags,
    cardType: 'MINION',
    name: `随从${attack}/${health}`,
  })
}

function player(overrides: Partial<PlayerView> = {}): PlayerView {
  return {
    name: 'P',
    hero: null,
    health: 20,
    armor: 0,
    mana: 10,
    maxMana: 10,
    hand: [],
    board: [],
    deckCount: 30,
    fatigue: 0,
    playedCards: [],
    secrets: 0,
    possibleSecrets: [],
    ...overrides,
  }
}

function snapshot(friendly: Partial<PlayerView>, opponent: Partial<PlayerView>, currentPlayerId = 1): GameSnapshot {
  return {
    turn: 5,
    currentPlayerId,
    players: { 1: player(friendly), 2: player(opponent) },
  }
}

describe('spellFaceDamage', () => {
  it('确定的直伤识别；随机/仅随从/无匹配/空文本返回 null', () => {
    expect(spellFaceDamage('造成 6 点伤害')).toBe(6)
    expect(spellFaceDamage('造成3点伤害')).toBe(3)
    expect(spellFaceDamage('随机造成 5 点伤害')).toBeNull()
    expect(spellFaceDamage('对一个敌方随从造成 5 点伤害')).toBeNull()
    expect(spellFaceDamage('亡语：造成 2 点伤害')).toBe(2)
    expect(spellFaceDamage('')).toBeNull()
    expect(spellFaceDamage('抽一张牌')).toBeNull()
  })
})

describe('knapsackPick', () => {
  it('空候选与零预算', () => {
    expect(knapsackPick([], 5)).toEqual([0, []])
    const [damage, detail] = knapsackPick([
      { cost: 2, damage: 5, name: '火球', source: 'spell', windfury: false },
      { cost: 0, damage: 1, name: '0费', source: 'spell', windfury: false },
    ], 0)
    expect(damage).toBe(1)
    expect(detail).toEqual([expect.objectContaining({ name: '0费' })])
  })

  it('预算内取伤害最大组合；超预算候选被排除', () => {
    const candidates = [
      { cost: 4, damage: 6, name: '火球', source: 'spell' as const, windfury: false },
      { cost: 1, damage: 3, name: '小弹', source: 'spell' as const, windfury: false },
      { cost: 9, damage: 10, name: '大爆炸', source: 'spell' as const, windfury: false },
    ]
    const [damage, detail] = knapsackPick(candidates, 5)
    expect(damage).toBe(9)
    expect(detail.map(d => d.name).sort()).toEqual(['小弹', '火球'])
  })

  it('并列最优与等价组合', () => {
    const [damage] = knapsackPick([
      { cost: 2, damage: 4, name: 'A', source: 'spell', windfury: false },
      { cost: 2, damage: 4, name: 'B', source: 'spell', windfury: false },
    ], 2)
    expect(damage).toBe(4)
  })
})

describe('minClearSubset', () => {
  const entries = [
    { damage: 3, name: 'a', source: 'board' as const },
    { damage: 2, name: 'b', source: 'spell' as const },
    { damage: 5, name: 'c', source: 'charge' as const },
  ]

  it('空条目或数量不足返回 null', () => {
    expect(minClearSubset([], 5, 1)).toBeNull()
    expect(minClearSubset(entries, 5, 4)).toBeNull()
  })

  it('选出满足伤害与条数的最小子集', () => {
    const result = minClearSubset(entries, 5, 1)
    expect(result).not.toBeNull()
    expect(result?.cost).toBeGreaterThanOrEqual(5)
    expect(result?.used.length).toBeGreaterThanOrEqual(1)
  })

  it('伤害需求为零时也要满足条数', () => {
    const result = minClearSubset(entries, 0, 2)
    expect(result).not.toBeNull()
    expect(result?.used.length).toBe(2)
  })

  it('不可达组合返回 null', () => {
    expect(minClearSubset([{ damage: 1, name: 'x', source: 'board' }], 99, 1)).toBeNull()
  })
})

describe('computeLethal', () => {
  it('非友方回合直接返回空结论', () => {
    const check = computeLethal(snapshot({}, {}, 2), 1)
    expect(check.availableDamage).toBe(0)
    expect(check.lethal).toBe(false)
    expect(check.summary()).toContain('场攻 0')
  })

  it('空场面无手牌：无伤害结论两种文案', () => {
    const noTaunt = computeLethal(snapshot({}, {}), 1)
    expect(noTaunt.availableDamage).toBe(0)
    expect(noTaunt.summary()).toContain('场攻 0')
  })

  it('纯场攻打脸与斩杀判定', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(6, 6), minionBoardCard(5, 5)] },
      { health: 11 },
    ), 1)
    expect(check.availableDamage).toBe(11)
    expect(check.lethal).toBe(true)
    expect(check.summary()).toContain('可斩杀')
  })

  it('伤害不足时给出差距', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(4, 4)] },
      { health: 20, armor: 2 },
    ), 1)
    expect(check.lethal).toBe(false)
    expect(check.deficit).toBe(18)
    expect(check.summary()).toContain('距斩杀还差 18')
  })

  it('手牌直伤受法力预算约束（背包）', () => {
    const check = computeLethal(snapshot(
      {
        mana: 4,
        hand: [handCard({ text: '造成 6 点伤害', cost: 4, name: '火球术' })],
      },
      { health: 6 },
    ), 1)
    expect(check.availableDamage).toBe(6)
    expect(check.lethal).toBe(true)
    expect(check.detail.some(d => d.source === 'spell')).toBe(true)
  })

  it('冲锋随从参与输出；随从位不足时被裁剪', () => {
    const withCharge = computeLethal(snapshot(
      {
        hand: [handCard({ attack: 4, cost: 2, flags: ['冲锋'], cardType: 'MINION', name: '冲锋崽' })],
      },
      { health: 4 },
    ), 1)
    expect(withCharge.availableDamage).toBe(4)
    expect(withCharge.lethal).toBe(true)

    const fullBoard = Array.from({ length: BOARD_SLOTS }, () => minionBoardCard(1, 1))
    const blocked = computeLethal(snapshot(
      {
        board: fullBoard,
        hand: [handCard({ attack: 9, cost: 2, flags: ['冲锋'], cardType: 'MINION', name: '大冲锋' })],
      },
      { health: 9 },
    ), 1)
    expect(blocked.availableDamage).toBe(7)
  })

  it('风怒随从攻击翻倍（场上与手牌冲锋两条路径）', () => {
    const boardWindfury = computeLethal(snapshot(
      { board: [minionBoardCard(3, 3, ['风怒'])] },
      { health: 6 },
    ), 1)
    expect(boardWindfury.availableDamage).toBe(6)

    const chargeWindfury = computeLethal(snapshot(
      { hand: [handCard({ attack: 2, cost: 1, flags: ['冲锋', '风怒'], cardType: 'MINION', name: '双头' })] },
      { health: 4 },
    ), 1)
    expect(chargeWindfury.availableDamage).toBe(4)
  })

  it('无法攻击的随从不计入（冻结/已尽/无法攻击/休眠）', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(9, 9, ['冻结']), minionBoardCard(9, 9, ['已尽'])] },
      { health: 10 },
    ), 1)
    expect(check.availableDamage).toBe(0)
  })

  it('嘲讽未清：仅法术伤害可打脸（tauntBlocked 文案）', () => {
    const check = computeLethal(snapshot(
      {
        board: [minionBoardCard(10, 10)],
        hand: [handCard({ text: '造成 3 点伤害', cost: 3, name: '小伤' })],
      },
      {
        health: 10,
        board: [minionBoardCard(2, 30, ['嘲讽'])],
      },
    ), 1)
    expect(check.tauntBlocked).toBe(true)
    expect(check.availableDamage).toBe(3)
    expect(check.summary()).toContain('嘲讽')
  })

  it('嘲讽可被清掉时剩余伤害打脸并标注清嘲讽花费', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(6, 6), minionBoardCard(6, 6)] },
      {
        health: 6,
        board: [minionBoardCard(2, 2, ['嘲讽'])],
      },
    ), 1)
    expect(check.tauntBlocked).toBe(false)
    expect(check.availableDamage).toBe(6)
    expect(check.tauntCost).toBe(6)
    expect(check.summary()).toContain('清除嘲讽花费')
  })

  it('免疫嘲讽清不掉', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(10, 10)] },
      {
        health: 10,
        board: [minionBoardCard(2, 2, ['嘲讽', '免疫'])],
      },
    ), 1)
    expect(check.tauntBlocked).toBe(true)
    expect(check.availableDamage).toBe(0)
  })

  it('圣盾嘲讽按多一次攻击吸收计（搜索窗内的可行组合）', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(2, 2), minionBoardCard(2, 2), minionBoardCard(2, 2)] },
      {
        health: 2,
        board: [minionBoardCard(1, 1, ['嘲讽', '圣盾'])],
      },
    ), 1)
    // 清 1 血+圣盾嘲讽需两次攻击（吸收 2+2）→ 剩 2 点打脸
    expect(check.availableDamage).toBe(2)
  })

  it('清嘲讽组合超出子集和搜索窗时保守判为被阻挡', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(4, 4), minionBoardCard(4, 4), minionBoardCard(4, 4)] },
      {
        health: 4,
        board: [minionBoardCard(1, 1, ['嘲讽', '圣盾'])],
      },
    ), 1)
    // 两次 4 点攻击的和超出 maxNeed 搜索窗 → 视为清不掉（宁可漏报）
    expect(check.tauntBlocked).toBe(true)
    expect(check.availableDamage).toBe(0)
  })

  it('对手牌库为空时附疲劳伤害提示（有伤害时才进文案）', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(3, 3)] },
      { deckCount: 0, fatigue: 4 },
    ), 1)
    expect(check.opponentFatigueDamage).toBe(5)
    expect(check.summary()).toContain('疲劳伤害')
  })

  it('英雄本体也可攻击（英雄 ATK 计入）', () => {
    const check = computeLethal(snapshot(
      { board: [handCard({ attack: 2, health: 30, cardType: 'HERO', flags: [], name: '英雄' })] },
      { health: 2 },
    ), 1)
    expect(check.availableDamage).toBe(2)
  })

  it('快照缺友方/对手条目时回退空结论', () => {
    const missing: GameSnapshot = {
      turn: 1,
      currentPlayerId: 1,
      players: { 1: player({}) },
    }
    const check = computeLethal(missing, 1)
    expect(check.availableDamage).toBe(0)
    expect(check.lethal).toBe(false)
  })
})

describe('LethalCandidateDetail', () => {
  it('detail 条目携带风怒标记', () => {
    const [, detail] = knapsackPick([
      { cost: 1, damage: 2, name: '双头', source: 'charge', windfury: true },
    ], 1)
    expect(detail[0]).toMatchObject({ name: '双头', damage: 2, windfury: true })
    const typed: LethalCandidateDetail = detail[0]!
    expect(typed.source).toBe('charge')
  })
})

describe('computeLethal 补充分支', () => {
  it('零伤害文本与空名/缺攻击力的候选回退', () => {
    expect(spellFaceDamage('造成 0 点伤害')).toBeNull()

    const check = computeLethal(snapshot(
      {
        hand: [
          handCard({ name: '', cost: null, text: '造成 2 点伤害', cardType: 'SPELL' }),
          handCard({ name: '', attack: null, cost: 1, flags: ['冲锋'], cardType: 'MINION' }),
          handCard({ name: '普通法术', cost: 1, text: '抽一张牌', cardType: 'SPELL' }),
        ],
      },
      { health: 2 },
    ), 1)
    expect(check.availableDamage).toBe(2)
    expect(check.detail.map(d => d.name)).toEqual(['法术'])
  })

  it('场面杂项：英雄技能类型不攻击；空类型无生命值不计随从位', () => {
    const check = computeLethal(snapshot(
      {
        board: [
          handCard({ name: '英雄技能', attack: 5, health: 5, cardType: 'HERO_POWER' }),
          handCard({ name: '占位', attack: null, health: null, cardType: '' }),
          handCard({ name: '真随从', attack: 2, health: 2, cardType: 'MINION', damaged: 0 }),
        ],
      },
      { health: 2 },
    ), 1)
    expect(check.availableDamage).toBe(2)
  })

  it('嘲讽无生命值按 0 计；无攻击条目时嘲讽不可清', () => {
    const check = computeLethal(snapshot(
      { board: [minionBoardCard(0, 1)] },
      {
        health: 1,
        board: [handCard({ name: '虚嘲讽', attack: 0, health: null, flags: ['嘲讽'], cardType: 'MINION' })],
      },
    ), 1)
    expect(check.tauntBlocked).toBe(true)
    expect(check.availableDamage).toBe(0)
  })

  it('手牌冲锋无风怒标志单次攻击', () => {
    const check = computeLethal(snapshot(
      { hand: [handCard({ attack: 5, cost: 1, flags: ['冲锋'], cardType: 'MINION', name: '单次' })] },
      { health: 5 },
    ), 1)
    expect(check.availableDamage).toBe(5)
    expect(check.lethal).toBe(true)
  })
})

describe('computeLethal 收尾分支', () => {
  it('法术伤害高于清嘲讽收益时保留法术打脸', () => {
    const check = computeLethal(snapshot(
      {
        board: [minionBoardCard(2, 2)],
        hand: [handCard({ text: '造成 10 点伤害', cost: 5, name: '大火球' })],
      },
      {
        health: 9,
        board: [minionBoardCard(8, 8, ['嘲讽'])],
      },
    ), 1)
    expect(check.tauntBlocked).toBe(true)
    expect(check.availableDamage).toBe(10)
  })

  it('冻结冲锋/空文本法术/空攻击力冲锋被排除', () => {
    const check = computeLethal(snapshot(
      {
        hand: [
          handCard({ attack: 9, cost: 1, flags: ['冲锋', '冻结'], cardType: 'MINION', name: '冻冲' }),
          handCard({ attack: null, cost: 1, flags: ['冲锋'], cardType: 'MINION', name: '软冲' }),
          handCard({ text: '', cost: 1, cardType: 'SPELL', name: '空法术' }),
        ],
      },
      { health: 1 },
    ), 1)
    expect(check.availableDamage).toBe(0)
  })

  it('空名冲锋随从回退命名；空名场攻随从回退命名', () => {
    const check = computeLethal(snapshot(
      {
        hand: [handCard({ attack: 3, cost: 1, flags: ['冲锋'], cardType: 'MINION', name: '' })],
        board: [handCard({ attack: 4, health: 4, cardType: 'MINION', name: '' })],
      },
      { health: 7 },
    ), 1)
    expect(check.availableDamage).toBe(7)
    expect(check.detail.map(d => d.name)).toEqual(['随从', '冲锋随从'])
  })

  it('零伤害且被嘲讽阻挡的文案分支', () => {
    const check = computeLethal(snapshot(
      {},
      { board: [minionBoardCard(5, 5, ['嘲讽'])] },
    ), 1)
    expect(check.availableDamage).toBe(0)
    expect(check.tauntBlocked).toBe(true)
    expect(check.summary()).toContain('对手嘲讽阻挡')
  })

  it('友方手牌为数量形态时按空手牌处理', () => {
    const friendly = player({ hand: { count: 3 } })
    const check = computeLethal(snapshot(friendly, {}), 1)
    expect(check.availableDamage).toBe(0)
  })
})

describe('computeLethal 最后分支', () => {
  it('空名风怒随从的第二次攻击条目也回退命名', () => {
    const check = computeLethal(snapshot(
      { board: [handCard({ attack: 2, health: 2, flags: ['风怒'], cardType: 'MINION', name: '' })] },
      { health: 4 },
    ), 1)
    expect(check.availableDamage).toBe(4)
    expect(check.detail.filter(d => d.name === '随从')).toHaveLength(2)
  })

  it('冲锋候选超过剩余随从位时按伤害排序截断', () => {
    const hand = Array.from({ length: 9 }, (_, i) =>
      handCard({ attack: i + 1, cost: 1, flags: ['冲锋'], cardType: 'MINION', name: `冲${i}` }))
    const fiveBoard = Array.from({ length: BOARD_SLOTS - 2 }, () => minionBoardCard(0, 1))
    const check = computeLethal(snapshot({ hand, board: fiveBoard }, { health: 6 }), 1)
    // 剩余 2 个随从位：仅伤害最高的两张冲锋（9、8）参战
    expect(check.availableDamage).toBe(17)
  })
})
