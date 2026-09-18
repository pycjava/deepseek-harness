/**
 * 状态序列化单元测试：友方检测/校准、合法可见过滤（隐藏信息断言）、
 * 英雄血量、契约转换与奥秘候选池。
 */
import { join } from 'node:path'
import { describe, expect, it, beforeAll } from 'vitest'
import { CardEntity, GameEntityModel, PlayerEntity } from '../src/core/entities.ts'
import { TAG, ZONE } from '../src/core/tags.ts'
import { GAME_TAG } from '../src/core/enums.generated.ts'
import { CardDatabase } from '../src/core/cards.ts'
import {
  calibrateFriendlyPlayer,
  detectFriendlyPlayerId,
  HiddenInfoViolationError,
  serializeGame,
  snapshotToContract,
} from '../src/core/state.ts'

const db = new CardDatabase([join(import.meta.dirname, '..', 'data')])

/** 造一棵最小对局树：游戏实体 1 + 两名玩家（实体 2/3，PlayerID 1/2）。 */
function makeGame(): GameEntityModel {
  const game = new GameEntityModel(1)
  game.registerEntity(new PlayerEntity(2, 1, 0, 0))
  game.registerEntity(new PlayerEntity(3, 2, 0, 0))
  return game
}

/** 造一张卡并注册进对局。 */
function addCard(
  game: GameEntityModel,
  id: number,
  cardId: string | null,
  zone: number,
  controller: number,
  tags: Array<[number, number]> = [],
): CardEntity {
  const merged = new Map<number, number>([[TAG.ZONE, zone], [TAG.CONTROLLER, controller], ...tags])
  const card = new CardEntity(id, cardId, merged)
  game.registerEntity(card)
  return card
}

const MINION_TYPE = 4
const TAUNT_TAG = GAME_TAG.TAUNT

describe('友方检测与校准', () => {
  it('手牌带 CardID 的唯一玩家即友方；空手牌与双方都带时返回 null', () => {
    const onlyFriendly = makeGame()
    addCard(onlyFriendly, 10, 'CS2_029', ZONE.HAND, 1)
    addCard(onlyFriendly, 11, null, ZONE.HAND, 2)
    expect(detectFriendlyPlayerId(onlyFriendly)).toBe(1)

    const empty = makeGame()
    expect(detectFriendlyPlayerId(empty)).toBeNull()

    const both = makeGame()
    addCard(both, 10, 'CS2_029', ZONE.HAND, 1)
    addCard(both, 11, 'CS2_029', ZONE.HAND, 2)
    expect(detectFriendlyPlayerId(both)).toBeNull()
  })

  it('calibrateFriendlyPlayer 优先取内联 SHOW_ENTITY 结果，缺失时回退检测', () => {
    const game = makeGame()
    game.friendlyPlayerByShow = 2
    expect(calibrateFriendlyPlayer(game)).toBe(2)
    game.friendlyPlayerByShow = null
    addCard(game, 10, 'CS2_029', ZONE.HAND, 1)
    expect(calibrateFriendlyPlayer(game)).toBe(1)
  })
})

describe('serializeGame', () => {
  beforeAll(async () => {
    await db.build()
  })

  it('回合/当前玩家取自游戏标签；缺失时回退玩家标签', () => {
    const tagged = makeGame()
    tagged.tags.set(TAG.TURN, 7)
    tagged.tags.set(TAG.CURRENT_PLAYER, 2)
    expect(serializeGame(tagged, 1).turn).toBe(7)
    expect(serializeGame(tagged, 1).currentPlayerId).toBe(2)

    const fallback = makeGame()
    const player = fallback.players[0]!
    player.tags.set(TAG.CURRENT_PLAYER, 1)
    const snapshot = serializeGame(fallback, 1)
    expect(snapshot.turn).toBe(0)
    expect(snapshot.currentPlayerId).toBe(1)
  })

  it('英雄实体存在时血量 = 实体 HEALTH - DAMAGE；缺失时回退玩家标签（0 视同未设置）', () => {
    const withHero = makeGame()
    const hero = addCard(withHero, 20, 'HERO_08', ZONE.PLAY, 1, [
      [TAG.HEALTH, 30],
      [TAG.DAMAGE, 6],
      [TAG.CARDTYPE, 2],
    ])
    withHero.players[0]!.tags.set(TAG.HERO_ENTITY, 20)
    withHero.players[0]!.tags.set(TAG.HEALTH, 25)
    expect(serializeGame(withHero, 1).players['1']?.health).toBe(24)
    expect(hero.cardId).toBe('HERO_08')

    const noHero = makeGame()
    noHero.players[1]!.tags.set(TAG.HEALTH, 17)
    noHero.players[1]!.tags.set(TAG.HERO_ENTITY, 999)
    expect(serializeGame(noHero, 1).players['2']?.health).toBe(17)
    expect(serializeGame(noHero, 1).players['2']?.hero).toBeNull()

    const zeroHealthFallback = makeGame()
    zeroHealthFallback.players[0]!.tags.set(TAG.HEALTH, 0)
    expect(serializeGame(zeroHealthFallback, 1).players['1']?.health).toBe(30)
  })

  it('友方手牌是卡牌列表；对手手牌只有数量', () => {
    const game = makeGame()
    addCard(game, 10, 'CS2_029', ZONE.HAND, 1)
    addCard(game, 11, null, ZONE.HAND, 2)
    addCard(game, 12, null, ZONE.HAND, 2)
    const snapshot = serializeGame(game, 1)
    expect(snapshot.players['1']?.hand).toMatchObject([{ cardId: 'CS2_029' }])
    expect(snapshot.players['2']?.hand).toEqual({ count: 2 })
  })

  it('对手手牌实体带 CardID 时拒绝序列化（隐藏信息硬约束）', () => {
    const game = makeGame()
    addCard(game, 11, 'CS2_029', ZONE.HAND, 2)
    expect(() => serializeGame(game, 1)).toThrow(HiddenInfoViolationError)
    expect(() => serializeGame(game, 1)).toThrow(/2/)
  })

  it('场面过滤英雄实体；无 CONTROLLER 的实体不计入任何玩家', () => {
    const game = makeGame()
    addCard(game, 20, 'HERO_08', ZONE.PLAY, 1, [[TAG.CARDTYPE, 2]])
    addCard(game, 21, 'CS2_042', ZONE.PLAY, 1, [[TAG.CARDTYPE, MINION_TYPE]])
    const orphan = new CardEntity(22, 'CS2_042', new Map([[TAG.ZONE, ZONE.PLAY]]))
    game.registerEntity(orphan)
    const board = serializeGame(game, 1).players['1']?.board ?? []
    expect(board.map(c => c.cardId)).toEqual(['CS2_042'])
  })

  it('卡牌字段经卡牌库补全（名称/职业/文本），未知卡回退占位', () => {
    const game = makeGame()
    addCard(game, 10, 'CS2_029', ZONE.HAND, 1)
    addCard(game, 11, 'NOT_A_CARD', ZONE.HAND, 1)
    const hand = serializeGame(game, 1, db).players['1']?.hand
    expect(Array.isArray(hand)).toBe(true)
    if (Array.isArray(hand)) {
      const fireball = hand[0]
      const unknown = hand[1]
      expect(fireball?.name).not.toBe('CS2_029')
      expect(unknown?.name).toBe('NOT_A_CARD')
      expect(unknown?.text).toBe('')
    }
  })

  it('对手有奥秘且英雄职业已知时给出标准池候选', () => {
    const game = makeGame()
    const hunterHero = addCard(game, 30, 'HERO_05', ZONE.PLAY, 2, [[TAG.CARDTYPE, 2]])
    expect(hunterHero.cardId).toBe('HERO_05')
    game.players[1]!.tags.set(TAG.HERO_ENTITY, 30)
    addCard(game, 31, null, ZONE.SECRET, 2)
    const snapshot = serializeGame(game, 1, db)
    const pool = snapshot.players['2']?.possibleSecrets ?? []
    expect(pool.length).toBeGreaterThan(0)
    expect(snapshot.players['2']?.secrets).toBe(1)
  })

  it('对手奥秘但无英雄职业（或无库）时候选为空', () => {
    const game = makeGame()
    addCard(game, 31, null, ZONE.SECRET, 2)
    expect(serializeGame(game, 1, db).players['2']?.possibleSecrets).toEqual([])
    expect(serializeGame(game, 1, null).players['2']?.possibleSecrets).toEqual([])
  })

  it('契约转换保持 snake_case 字段且受伤归一', () => {
    const game = makeGame()
    const taunt = TAUNT_TAG === undefined ? [] : [[TAUNT_TAG, 1] as [number, number]]
    const card = addCard(game, 21, 'CS2_042', ZONE.PLAY, 1, [
      [TAG.CARDTYPE, MINION_TYPE],
      [TAG.ATK, 3],
      [TAG.HEALTH, 2],
      [TAG.DAMAGE, 1],
      [TAG.COST, 2],
      ...taunt,
    ])
    expect(card.id).toBe(21)
    const contract = snapshotToContract(serializeGame(game, 1, db))
    expect(contract.turn).toBe(0)
    const board = contract.players['1']?.board ?? []
    expect(board[0]).toMatchObject({
      card_id: 'CS2_042',
      attack: 3,
      health: 2,
      damaged: 1,
      cost: 2,
    })
    expect(board[0]?.flags).toContain('嘲讽')
    expect(contract.players['1']).not.toHaveProperty('draw_odds')
  })
})

describe('serializeGame 补充分支', () => {
  it('手牌实体无 CONTROLLER 标签时不计入任何玩家', async () => {
    const game = makeGame()
    const orphan = new CardEntity(30, 'CS2_029', new Map([[TAG.ZONE, ZONE.HAND]]))
    game.registerEntity(orphan)
    const snapshot = serializeGame(game, 1)
    expect(snapshot.players['1']?.hand).toEqual([])
    expect(orphan.zone()).toBe(ZONE.HAND)
  })
})

describe('cardTypeName 未知值', () => {
  it('CARDTYPE 为未知数值时 cardType 为 null', () => {
    const game = makeGame()
    addCard(game, 21, 'CS2_042', ZONE.PLAY, 1, [[TAG.CARDTYPE, 999_999]])
    const board = serializeGame(game, 1).players['1']?.board ?? []
    expect(board[0]?.cardType).toBeNull()
  })
})
