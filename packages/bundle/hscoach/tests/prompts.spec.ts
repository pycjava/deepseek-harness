/**
 * 教练 prompt 单元测试：系统 prompt 模式分支与局面文本渲染
 * （空场/疲劳/奥秘/抽牌概率/伤害评估/缺对手兜底）。
 */
import { describe, expect, it } from 'vitest'
import type { CardViewContract, SnapshotContract } from '../src/core/state.ts'
import { buildUserPrompt, getSystemPrompt } from '../src/advice/prompts.ts'

function card(overrides: Partial<CardViewContract> = {}): CardViewContract {
  return {
    card_id: 'CS2_042',
    name: '测试卡',
    cost: 2,
    attack: 3,
    health: 2,
    flags: [],
    text: '效果',
    damaged: null,
    card_type: 'MINION',
    card_class: 'NEUTRAL',
    ...overrides,
  }
}

function contract(overrides: Partial<SnapshotContract> = {}): SnapshotContract {
  return {
    turn: 5,
    current_player_id: 1,
    players: {
      1: {
        name: '我',
        health: 25,
        armor: 2,
        mana: 4,
        max_mana: 5,
        hand: [card()],
        board: [card({ flags: ['嘲讽'], damaged: 1 })],
        deck_count: 12,
        fatigue: 0,
        played_cards: [card({ name: '已出的牌' })],
        secrets: 0,
        possible_secrets: [],
      },
      2: {
        name: '对手',
        health: 20,
        armor: 0,
        mana: 3,
        max_mana: 5,
        hand: { count: 6 },
        board: [],
        deck_count: 9,
        fatigue: 0,
        played_cards: [],
        secrets: 0,
        possible_secrets: [],
      },
    },
    ...overrides,
  }
}

describe('getSystemPrompt', () => {
  it('三种模式与默认回退都注入对应的模式段', () => {
    expect(getSystemPrompt('teach')).toContain('【教学模式】')
    expect(getSystemPrompt('compete')).toContain('【竞赛模式】')
    expect(getSystemPrompt('silent')).toContain('【静默模式】')
    expect(getSystemPrompt()).toContain('【教学模式】')
    expect(getSystemPrompt('不存在的模式')).toContain('【教学模式】')
    expect(getSystemPrompt('teach')).toContain('规则：')
  })
})

describe('buildUserPrompt', () => {
  it('渲染手牌/场面/已出牌/抽牌概率与空对手场', () => {
    const text = buildUserPrompt(contract(), 1)
    expect(text).toContain('=== 当前回合 5')
    expect(text).toContain('手牌（1张）')
    expect(text).toContain('测试卡（2费） 3/2 效果')
    expect(text).toContain('[嘲讽]')
    expect(text).toContain('(受伤1)')
    expect(text).toContain('已出牌：已出的牌')
    expect(text).not.toContain('对手已出牌')
    expect(text).toContain('牌库剩余：12 张')
    expect(text).toContain('【抽牌概率】')
    expect(text).toContain('（空场）')
    expect(text).toContain('手牌：6 张（隐藏，不知具体）')
  })

  it('手牌无攻击力、对手牌库为空（疲劳行）与无抽牌概率分支', () => {
    const empty = contract({
      players: {
        1: {
          name: '我',
          health: 30,
          armor: 0,
          mana: 1,
          max_mana: 1,
          hand: [card({ attack: null, cost: null })],
          board: [],
          deck_count: 0,
          fatigue: 3,
          played_cards: [],
          secrets: 0,
          possible_secrets: [],
        },
        2: {
          name: '对手',
          health: 30,
          armor: 0,
          mana: 1,
          max_mana: 1,
          hand: { count: 2 },
          board: [],
          deck_count: 0,
          fatigue: 1,
          played_cards: [card({ name: '对手的牌' })],
          secrets: 0,
          possible_secrets: [],
        },
      },
    })
    const text = buildUserPrompt(empty, 1)
    expect(text).toContain('（?费）')
    expect(text).toContain('牌库已空：下回合抽牌将受 4 点疲劳伤害')
    expect(text).toContain('对手牌库已空：其下回合抽牌将受 2 点疲劳伤害')
    expect(text).not.toContain('【抽牌概率】')
    expect(text).toContain('对手已出牌：对手的牌')
  })

  it('奥秘行：有候选池与无候选池两种渲染', () => {
    const withPool = contract()
    withPool.players['2']!.secrets = 2
    withPool.players['2']!.possible_secrets = ['爆炸陷阱', '冰冻陷阱']
    expect(buildUserPrompt(withPool, 1)).toContain('可能为：爆炸陷阱、冰冻陷阱')

    const noPool = contract()
    noPool.players['2']!.secrets = 1
    expect(buildUserPrompt(noPool, 1)).toContain('标准池无此职业奥秘')
  })

  it('附伤害评估行（lethal 摘要注入）', () => {
    const text = buildUserPrompt(contract(), 1, {
      availableDamage: 0,
      lethal: false,
      detail: [],
      deficit: 20,
      tauntBlocked: false,
      tauntCost: 0,
      opponentFatigueDamage: null,
      summary: () => '本回合无确定直接伤害（场攻 0）。',
    })
    expect(text).toContain('【伤害评估】本回合无确定直接伤害（场攻 0）。')
  })

  it('快照缺对手玩家时走空玩家兜底', () => {
    const solo = contract({
      players: {
        1: {
          name: '我',
          health: 30,
          armor: 0,
          mana: 1,
          max_mana: 1,
          hand: [],
          board: [],
          deck_count: 5,
          fatigue: 0,
          played_cards: [],
          secrets: 0,
          possible_secrets: [],
        },
      },
    })
    const text = buildUserPrompt(solo, 1)
    expect(text).toContain('【对手】')
    expect(text).toContain('手牌：0 张（隐藏，不知具体）')
    expect(text).toContain('对手牌库剩余：0 张')
  })
})

describe('getSystemPrompt 空串与场面旗标', () => {
  it('空串模式回退默认教学模式', () => {
    expect(getSystemPrompt('')).toContain('【教学模式】')
  })

  it('场面卡无旗标无受伤时省略附加段', () => {
    const plain = contract({
      players: {
        1: {
          name: '我',
          health: 30,
          armor: 0,
          mana: 1,
          max_mana: 1,
          hand: [],
          board: [card({ flags: [], damaged: null })],
          deck_count: 5,
          fatigue: 0,
          played_cards: [],
          secrets: 0,
          possible_secrets: [],
        },
        2: {
          name: '对手',
          health: 30,
          armor: 0,
          mana: 1,
          max_mana: 1,
          hand: { count: 5 },
          board: [card({ flags: ['嘲讽'], damaged: 2 })],
          deck_count: 5,
          fatigue: 0,
          played_cards: [],
          secrets: 0,
          possible_secrets: [],
        },
      },
    })
    const text = buildUserPrompt(plain, 1)
    expect(text).toContain('测试卡 3/2')
    expect(text).toContain('(受伤2)')
    expect(text).toContain('[嘲讽]')
  })
})

describe('buildUserPrompt 兜底终批', () => {
  it('快照缺失友方条目时走空玩家（手牌数量形态）', () => {
    const solo = contract()
    delete (solo.players as Record<string, unknown>)['2']
    const text = buildUserPrompt(solo, 99)
    expect(text).toContain('轮到玩家 99 出牌')
    expect(text).toContain('手牌（0张）')
  })

  it('友方手牌为数量形态按空手牌渲染；对手手牌为数组的异常形态回退占位', () => {
    const weird = contract()
    ;(weird.players['1'] as { hand: unknown }).hand = { count: 9 }
    ;(weird.players['2'] as { hand: unknown }).hand = [card()]
    const text = buildUserPrompt(weird, 1)
    expect(text).toContain('手牌（0张）')
    expect(text).toContain('手牌：? 张（隐藏，不知具体）')
  })
})
