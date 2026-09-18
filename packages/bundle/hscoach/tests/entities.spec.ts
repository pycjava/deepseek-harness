/**
 * 实体模型单元测试：区域查询、揭示/隐藏/变换、GAME_RESET 与
 * 注册/查找/导出级错误。
 */
import { describe, expect, it } from 'vitest'
import {
  CardEntity,
  GameEntityModel,
  GameExportError,
  PlayerEntity,
} from '../src/core/entities.ts'
import { TAG, ZONE } from '../src/core/tags.ts'

describe('CardEntity', () => {
  it('zone 缺标签回退 INVALID；reveal/hide/change 维护揭示态与标签合并', () => {
    const card = new CardEntity(10, null, new Map())
    expect(card.zone()).toBe(ZONE.INVALID)

    card.tags.set(TAG.ZONE, ZONE.HAND)
    expect(card.zone()).toBe(ZONE.HAND)

    card.reveal('EX1_015', new Map([[TAG.ATK, 3]]))
    expect(card.cardId).toBe('EX1_015')
    expect(card.revealed).toBe(true)
    expect(card.tags.get(TAG.ATK)).toBe(3)

    card.hide()
    expect(card.revealed).toBe(false)

    card.change('NEW_001', new Map([[TAG.HEALTH, 5]]))
    expect(card.cardId).toBe('NEW_001')
    expect(card.tags.get(TAG.HEALTH)).toBe(5)
  })

  it('change 无原 CardID 抛导出级错误；reset 还原揭示态', () => {
    const bare = new CardEntity(11, null, new Map())
    expect(() =>{  bare.change('X', new Map()) }).toThrow(GameExportError)

    const card = new CardEntity(12, 'A', new Map())
    card.reveal('B', new Map())
    card.reset()
    expect(card.cardId).toBeNull()
    expect(card.revealed).toBe(false)
  })
})

describe('GameEntityModel', () => {
  it('注册玩家进 players；inZone 过滤游戏自身；按 id 查找', () => {
    const game = new GameEntityModel(1)
    expect(game.findEntityById(1)).toBe(game)
    expect(game.players).toHaveLength(0)

    const player = new PlayerEntity(2, 1, 0, 0)
    const card = new CardEntity(10, 'CS2_029', new Map([[TAG.ZONE, ZONE.HAND]]))
    player.tags.set(TAG.ZONE, ZONE.PLAY)
    game.registerEntity(player)
    game.registerEntity(card)

    expect(game.players).toEqual([player])
    expect(game.inZone(ZONE.HAND)).toEqual([card])
    expect(game.inZone(ZONE.PLAY)).toEqual([player])
    expect(game.inZone(ZONE.DECK)).toEqual([])
    expect(game.findEntityById(99)).toBeUndefined()
  })

  it('GAME_RESET 只重置卡牌实体', () => {
    const game = new GameEntityModel(1)
    const card = new CardEntity(10, 'A', new Map())
    card.reveal('B', new Map())
    const player = new PlayerEntity(2, 1, 0, 0)
    player.tags.set(TAG.HEALTH, 30)
    game.registerEntity(player)
    game.registerEntity(card)
    game.reset()
    expect(card.cardId).toBeNull()
    expect(player.tags.get(TAG.HEALTH)).toBe(30)
  })
})
