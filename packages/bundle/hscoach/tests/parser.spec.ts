/**
 * Power.log 解析器单元测试：行级跳过/丢局边界、实体树构建、
 * SHOW/HIDE/CHANGE、TAG_CHANGE 名字引用与延迟回放、Choices/Mulligan。
 */
import { describe, expect, it } from 'vitest'
import { CardEntity } from '../src/core/entities.ts'
import { GAME_TAG } from '../src/core/enums.generated.ts'
import { TAG } from '../src/core/tags.ts'
import { isCreateGameLine, parsePowerLog, stripPowerPrefix } from '../src/core/parser.ts'

/** 造一行 GameState.DebugPrintPower 数据。 */
function power(data: string): string {
  return `D 10:00:00.0000000 GameState.DebugPrintPower() - ${data}`
}

/** 造一行 GameState.DebugPrintGame 数据。 */
function meta(data: string): string {
  return `D 10:00:00.0000000 GameState.DebugPrintGame() - ${data}`
}

function choicesLine(data: string): string {
  return `D 10:00:00.0000000 GameState.DebugPrintEntityChoices() - ${data}`
}

function chosenLine(data: string): string {
  return `D 10:00:00.0000000 GameState.DebugPrintEntitiesChosen() - ${data}`
}

/** 最小可解析开局：游戏实体 + 两名玩家（玩家 2 为 AI）+ 一张友方手牌。 */
const OPENING = [
  power('CREATE_GAME'),
  power('GameEntity EntityID=1'),
  power('tag=TURN value=1'),
  power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
  power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=0]'),
  power('FULL_ENTITY - Creating ID=10 CardID=CS2_029'),
  power('tag=ZONE value=HAND'),
  power('tag=CONTROLLER value=1'),
]

describe('stripPowerPrefix / isCreateGameLine', () => {
  it('剥离开剥离两种形态与边界判定', () => {
    expect(stripPowerPrefix('[Power] D 10:00:00.0000000 x')).toBe('D 10:00:00.0000000 x')
    expect(stripPowerPrefix('D 10:00:00.0000000 x')).toBe('D 10:00:00.0000000 x')
    expect(isCreateGameLine(power('CREATE_GAME'))).toBe(true)
    expect(isCreateGameLine('D 10:00:00.0 PowerTaskList.DebugPrintPower() - CREATE_GAME')).toBe(false)
    expect(isCreateGameLine(power('TAG_CHANGE x'))).toBe(false)
  })
})

describe('parsePowerLog 基础流', () => {
  it('最小开局：两玩家 + 友方推断 + 手牌实体', () => {
    const result = parsePowerLog(OPENING)
    expect(result.skippedLines).toBe(0)
    expect(result.skippedGames).toBe(0)
    expect(result.games).toHaveLength(1)
    const game = result.games[0]!
    expect(game.tags.get(TAG.TURN)).toBe(1)
    expect(game.players.map(p => p.playerId).sort()).toEqual([1, 2])
    expect(game.friendlyPlayerByShow).toBe(1)
    const card = game.findEntityById(10)
    expect(card).toBeInstanceOf(CardEntity)
    expect((card as CardEntity).cardId).toBe('CS2_029')
    expect(card?.tags.get(TAG.ZONE)).toBe(3)
    expect(card?.tags.get(TAG.CONTROLLER)).toBe(1)
  })

  it('[Power] 前缀、空行、无方法行与 CREATE_GAME 前的行都不影响解析', () => {
    const lines = [
      '',
      '   ',
      power('TAG_CHANGE Entity=5 tag=ZONE value=DECK'),
      '[Power] D 10:00:00.0000000 GameState.DebugPrintPower() - CREATE_GAME',
      'D 10:00:01.0000000 不是方法行',
      ...OPENING.slice(1).map(l => `[Power] ${l}`),
    ]
    const result = parsePowerLog(lines)
    expect(result.games).toHaveLength(1)
    expect(result.skippedLines).toBe(0)
  })

  it('坏时间戳行与非时间戳行计入跳过', () => {
    const result = parsePowerLog([
      power('CREATE_GAME'),
      'X 10:00:00.0000000 GameState.DebugPrintPower() - GameEntity EntityID=1',
      'no timestamp at all',
      ...OPENING.slice(1),
    ])
    expect(result.skippedLines).toBe(2)
    expect(result.games).toHaveLength(1)
  })

  it('旁观者行跳过（须在对局内才计数）', () => {
    const result = parsePowerLog([
      ...OPENING,
      'D 10:00:00.0 GameState.DebugPrintPower() - ====================================== SPECTATOR MODE',
    ])
    expect(result.skippedLines).toBe(1)
  })

  it('CREATE_GAME 边界切局；仅 CREATE_GAME 的空局也产出空模型', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('CREATE_GAME'),
      power('CREATE_GAME'),
      ...OPENING.slice(1),
    ])
    // 第一局 + 中间空局 + 第三局（beginGame 即建模型，空局不丢）
    expect(result.games).toHaveLength(3)
    const emptyOnly = parsePowerLog([power('CREATE_GAME')])
    expect(emptyOnly.games).toHaveLength(1)
  })
})

describe('行级错误（跳行）', () => {
  it('GameEntity id 不匹配与坏 Player 行各跳一行', () => {
    const mismatch = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('GameEntity EntityID=9'),
      ...OPENING.slice(3),
    ])
    expect(mismatch.skippedLines).toBe(1)

    const badPlayer = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('Player EntityID=2 PlayerID=1 badformat'),
      ...OPENING.slice(3),
    ])
    expect(badPlayer.skippedLines).toBe(1)
    expect(badPlayer.games).toHaveLength(1)
  })

  it('tag= 行在无归属包时 / 坏 tag 行 / 未知 GameTag / 未知枚举值', () => {
    // HIDE_ENTITY 不建 pending：其后紧跟的 tag= 行无归属 → 跳行
    const early = parsePowerLog([
      ...OPENING,
      power('HIDE_ENTITY - Entity=10 tag=ZONE value=DECK'),
      power('tag=TURN value=1'),
    ])
    expect(early.skippedLines).toBe(1)

    const bad = parsePowerLog([...OPENING, power('tag=TURN')])
    expect(bad.skippedLines).toBe(1)

    const unknownTag = parsePowerLog([...OPENING, power('tag=NOT_A_REAL_TAG value=1')])
    expect(unknownTag.skippedLines).toBe(1)

    const unknownValue = parsePowerLog([...OPENING, power('tag=ZONE value=NOT_A_ZONE')])
    expect(unknownValue.skippedLines).toBe(1)
  })

  it('未识别的操作码跳行；ERROR:/Info[/Source/Targets[ 静默忽略', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('TOTALLY_UNKNOWN_OPCODE something'),
      power('ERROR: 5'),
      power('Info[1] - hi'),
      power('Source - x'),
      power('Targets[0] - y'),
    ])
    expect(result.skippedLines).toBe(1)
    expect(result.games).toHaveLength(1)
  })
})

describe('丢局边界（GameExportError）', () => {
  it('TAG_CHANGE Entity=-1 丢弃整局', () => {
    const result = parsePowerLog([...OPENING, power('TAG_CHANGE Entity=-1 tag=ZONE value=DECK')])
    expect(result.skippedGames).toBe(1)
    expect(result.games).toHaveLength(0)
  })

  it('SHOW/HIDE/CHANGE 指向未知实体丢弃整局', () => {
    const show = parsePowerLog([...OPENING, power('SHOW_ENTITY - Updating Entity=999 CardID=CS2_029')])
    expect(show.skippedGames).toBe(1)

    const hide = parsePowerLog([...OPENING, power('HIDE_ENTITY - Entity=999 tag=ZONE value=DECK')])
    expect(hide.skippedGames).toBe(1)

    const change = parsePowerLog([...OPENING, power('CHANGE_ENTITY - Updating Entity=999 CardID=CS2_029')])
    expect(change.skippedGames).toBe(1)
  })

  it('TAG_CHANGE 指向未注册实体丢弃整局', () => {
    const result = parsePowerLog([...OPENING, power('TAG_CHANGE Entity=777 tag=ZONE value=DECK')])
    expect(result.skippedGames).toBe(1)
  })

  it('FULL_ENTITY 落在玩家实体上丢弃整局', () => {
    const result = parsePowerLog([...OPENING, power('FULL_ENTITY - Updating 2 CardID=CS2_029')])
    expect(result.skippedGames).toBe(1)
  })

  it('局末仍有未解析的延迟 TAG_CHANGE 丢弃整局', () => {
    // 名字引用 + 非实体 tag → 延迟队列，且整局无赋值行
    const result = parsePowerLog([
      ...OPENING,
      power('TAG_CHANGE Entity=某些玩家 tag=HEALTH value=30'),
    ])
    expect(result.skippedGames).toBe(1)
  })
})

describe('SHOW / HIDE / CHANGE / FULL_ENTITY Updating', () => {
  it('SHOW_ENTITY 揭示已注册卡；HIDE_ENTITY 非 ZONE tag 跳行；隐藏只撤销揭示不改 ZONE', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('SHOW_ENTITY - Updating Entity=10 CardID=EX1_015'),
      power('tag=ZONE value=HAND'),
      power('HIDE_ENTITY - Entity=10 tag=ZONE value=DECK'),
      power('HIDE_ENTITY - Entity=10 tag=ATK value=3'),
      power('TAG_CHANGE Entity=10 tag=ZONE value=DECK'),
      power('SHOW_ENTITY - Updating Entity=10 CardID=CS2_029'),
    ])
    expect(result.skippedLines).toBe(1)
    const card = result.games[0]!.findEntityById(10) as CardEntity
    expect(card.cardId).toBe('CS2_029')
    expect(card.revealed).toBe(true)
    // HIDE 只撤销揭示；ZONE 移动由 TAG_CHANGE 驱动（Zone 枚举 DECK=2）
    expect(card.tags.get(TAG.ZONE)).toBe(2)
  })

  it('CHANGE_ENTITY 变换已知卡；无原 CardID 时丢局', () => {
    const ok = parsePowerLog([
      ...OPENING,
      power('CHANGE_ENTITY - Updating Entity=10 CardID=NEW_001'),
    ])
    expect((ok.games[0]!.findEntityById(10) as CardEntity).cardId).toBe('NEW_001')

    const bare = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      power('FULL_ENTITY - Creating ID=10'),
      power('CHANGE_ENTITY - Updating Entity=10 CardID=NEW_001'),
    ])
    expect(bare.skippedGames).toBe(1)
  })

  it('FULL_ENTITY Updating 更新既有卡 / 创建新卡（空 CardID）/ 括号实体令牌', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('FULL_ENTITY - Updating 10 CardID=EX1_015'),
      power('FULL_ENTITY - Creating ID=11 CardID='),
      power('FULL_ENTITY - Updating [entityName id=12 zone=PLAY] CardID=CS2_042'),
      power('tag=ZONE value=PLAY'),
    ])
    expect(result.skippedLines).toBe(0)
    expect(result.games[0]!.findEntityById(10)).toBeInstanceOf(CardEntity)
    expect((result.games[0]!.findEntityById(10) as CardEntity).cardId).toBe('EX1_015')
    expect(result.games[0]!.findEntityById(11)).toBeInstanceOf(CardEntity)
    expect(result.games[0]!.findEntityById(12)).toBeInstanceOf(CardEntity)
  })

  it('坏 FULL_ENTITY 行跳过', () => {
    const result = parsePowerLog([...OPENING, power('FULL_ENTITY - Creating')])
    expect(result.skippedLines).toBe(1)
  })
})

describe('TAG_CHANGE 名字引用与延迟回放', () => {
  it('数字实体的 TAG_CHANGE 直接落地并记账 CONTROLLER', () => {
    const result = parsePowerLog([...OPENING, power('TAG_CHANGE Entity=10 tag=CONTROLLER value=2')])
    expect(result.games[0]!.findEntityById(10)?.tags.get(TAG.CONTROLLER)).toBe(2)
  })

  it('玩家名引用获得 ENTITY_ID 赋值后回放延迟包', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('TAG_CHANGE Entity=玩家甲 tag=HEALTH value=25'),
      power('TAG_CHANGE Entity=玩家甲 tag=ENTITY_ID value=2'),
    ])
    expect(result.skippedGames).toBe(0)
    expect(result.games[0]!.findEntityById(2)?.tags.get(TAG.HEALTH)).toBe(25)
  })

  it('LAST_CARD_PLAYED 经控制者合并解析到实体', () => {
    const result = parsePowerLog([
      ...OPENING,
      // 卡 10 的控制者是玩家 1（playerId），LAST_CARD_PLAYED 由此归并
      power('TAG_CHANGE Entity=玩家甲 tag=LAST_CARD_PLAYED value=10'),
    ])
    expect(result.skippedGames).toBe(0)
    expect(result.games).toHaveLength(1)
  })

  it('LAST_CARD_PLAYED 指向未知实体跳行', () => {
    const result = parsePowerLog([...OPENING, power('TAG_CHANGE Entity=玩家甲 tag=LAST_CARD_PLAYED value=555')])
    expect(result.skippedLines).toBe(1)
  })
})

describe('Blocks', () => {
  function blockLine(type: string): string {
    return power(
      `BLOCK_START BlockType=${type} Entity=GameEntity EffectCardId= EffectIndex=-1 Target=GameEntity`,
    )
  }

  it('常规块起止与未知 BlockType', () => {
    const ok = parsePowerLog([...OPENING, blockLine('PLAY'), power('BLOCK_END'), power('BLOCK_END')])
    expect(ok.skippedLines).toBe(0)

    const unknown = parsePowerLog([...OPENING, blockLine('NOT_A_TYPE')])
    expect(unknown.skippedLines).toBe(1)
  })

  it('SubOption/Trigger 与 ACTION_START 各形态', () => {
    const sub = parsePowerLog([
      ...OPENING,
      power('BLOCK_START BlockType=TRIGGER Entity=10 EffectCardId= EffectIndex=-1 Target=GameEntity SubOption=-1 TriggerKeyword=TURN_START'),
      power('BLOCK_END'),
    ])
    expect(sub.skippedLines).toBe(0)

    const action = parsePowerLog([
      ...OPENING,
      power('ACTION_START SubType=TRIGGER Entity=10 EffectCardId= EffectIndex=-1 Target=GameEntity'),
      power('ACTION_END'),
    ])
    expect(action.skippedLines).toBe(0)

    const old = parsePowerLog([
      ...OPENING,
      power('ACTION_START Entity=10 SubType=TRIGGER Index=-1 Target=GameEntity'),
      power('ACTION_END'),
    ])
    expect(old.skippedLines).toBe(0)

    const badEnd = parsePowerLog([...OPENING, power('BLOCK_END')]).skippedLines
    expect(badEnd).toBe(0)
    const badEndToken = parsePowerLog([...OPENING, power('BLOCK_END extra')])
    expect(badEndToken.skippedLines).toBe(1)
  })

  it('GAME_RESET 块重置卡牌揭示', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('SHOW_ENTITY - Updating Entity=10 CardID=EX1_015'),
      power('tag=ZONE value=HAND'),
      blockLine('GAME_RESET'),
      power('BLOCK_END'),
    ])
    expect((result.games[0]!.findEntityById(10) as CardEntity).revealed).toBe(false)
  })

  it('首个 FULL_ENTITY 前玩家不足 2 名时跳行', () => {
    const result = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('FULL_ENTITY - Creating ID=10 CardID=CS2_029'),
      ...OPENING.slice(1),
    ])
    expect(result.skippedLines).toBe(1)
  })
})

describe('Game meta 与 Choices', () => {
  it('PlayerID= 元数据注册玩家名；坏元数据跳行；数值键值静默丢弃', () => {
    const result = parsePowerLog([
      ...OPENING,
      meta('PlayerID=1, PlayerName=真名'),
      meta('GameType=7'),
      meta('badmeta'),
    ])
    expect(result.skippedLines).toBe(1)
    expect(result.games).toHaveLength(1)
  })

  it('Mulligan choices：名字 → choiceId → playerId 回执映射', () => {
    const result = parsePowerLog([
      ...OPENING,
      choicesLine('id=77 Player=玩家甲 TaskList=1 ChoiceType=MULLIGAN CountMin=0 CountMax=3'),
      choicesLine('Entities[0]=[entityName id=10 zone=HAND]'),
      power('tag=CONTROLLER value=1'), // 让包 flush 时选择实体控制者已知
      chosenLine('id=77 Player=玩家甲 EntitiesCount=3'),
      chosenLine('Entities[0]=[entityName id=10 zone=HAND]'),
    ])
    expect(result.skippedLines).toBe(0)
    expect(result.games).toHaveLength(1)
  })

  it('非 MULLIGAN choice 类型与 Source= 行被接受；坏 choice 行跳过', () => {
    const result = parsePowerLog([
      ...OPENING,
      choicesLine('id=78 Player=玩家甲 TaskList= ChoiceType=GENERAL CountMin=1 CountMax=2'),
      choicesLine('Source=[entityName id=10 zone=HAND]'),
      choicesLine('id=79 nonsense'),
      chosenLine('id=78 Player=玩家甲 EntitiesCount=1'),
      chosenLine('Entities[0]=10'),
    ])
    expect(result.skippedLines).toBe(1)
  })
})

describe('GAME_TAG 导出兼容', () => {
  it('生成表常量可直接消费', () => {
    expect(typeof GAME_TAG.ENTITY_ID).toBe('number')
    expect(GAME_TAG.ENTITY_ID).toBeGreaterThan(0)
  })
})

describe('各操作码的坏行与 Choices 边界', () => {
  it('每一类坏正则行都计一次跳过', () => {
    const cases = [
      power('GameEntity garbage'),
      power('FULL_ENTITY - Updating'),
      power('SHOW_ENTITY - Updating Entity=10'),
      power('HIDE_ENTITY - Entity=10 tag=ZONE'),
      power('CHANGE_ENTITY - Updating Entity=10'),
      choicesLine('Entities[0]=不是括号'),
      choicesLine('完全未知的选项行'),
      chosenLine('id=abc Player=x EntitiesCount=1'),
      chosenLine('Entities[0]=某名字'),
      meta('PlayerID=abc, PlayerName=x'),
    ]
    const result = parsePowerLog([...OPENING, ...cases])
    expect(result.skippedLines).toBe(cases.length)
    expect(result.games).toHaveLength(1)

    // 坏 CREATE_GAME 行本身是对局边界：错误落在新局里计一次跳过
    const badCreate = parsePowerLog([...OPENING, power('CREATE_GAME extra'), power('tag=TURN value=1')])
    expect(badCreate.skippedLines).toBeGreaterThanOrEqual(1)
  })

  it('chosen 实体先于包头 / 超出计数 / Player=-1 各自跳过或忽略', () => {
    const orphanEntity = parsePowerLog([...OPENING, chosenLine('Entities[0]=10')])
    expect(orphanEntity.skippedLines).toBe(1)

    const overflow = parsePowerLog([
      ...OPENING,
      choicesLine('id=80 Player=玩家甲 TaskList= ChoiceType=GENERAL CountMin=1 CountMax=2'),
      chosenLine('id=80 Player=玩家甲 EntitiesCount=1'),
      chosenLine('Entities[0]=10'),
      chosenLine('Entities[1]=11'),
    ])
    expect(overflow.skippedLines).toBe(1)

    const negative = parsePowerLog([
      ...OPENING,
      choicesLine('id=81 Player=-1 TaskList= ChoiceType=GENERAL CountMin=1 CountMax=2'),
    ])
    expect(negative.skippedLines).toBe(0)
  })

  it('Mulligan 包内未知实体与零选择路径', () => {
    const unknownChoiceEntity = parsePowerLog([
      ...OPENING,
      choicesLine('id=82 Player=玩家甲 TaskList= ChoiceType=MULLIGAN CountMin=0 CountMax=3'),
      choicesLine('Entities[0]=[entityName id=999 zone=HAND]'),
      power('GameEntity EntityID=1'),
    ])
    expect(unknownChoiceEntity.skippedLines).toBe(1)

    const zeroChoices = parsePowerLog([
      ...OPENING,
      choicesLine('id=83 Player=玩家乙 TaskList= ChoiceType=MULLIGAN CountMin=0 CountMax=3'),
      power('GameEntity EntityID=1'),
    ])
    expect(zeroChoices.skippedLines).toBe(0)
  })

  it('数字玩家的 chosen 回执不写 mulligan 映射', () => {
    const result = parsePowerLog([
      ...OPENING,
      chosenLine('id=90 Player=1 EntitiesCount=1'),
      chosenLine('Entities[0]=10'),
    ])
    expect(result.skippedLines).toBe(0)
  })
})

describe('解析器补充分支', () => {
  it('FULL_ENTITY Updating 空 CardID / SubOption 无 Trigger 形态 / 玩家实体上的 SHOW', () => {
    const emptyUpdate = parsePowerLog([...OPENING, power('FULL_ENTITY - Updating 10 CardID=')])
    expect((emptyUpdate.games[0]!.findEntityById(10) as CardEntity).cardId).toBeNull()

    const subOptionOnly = parsePowerLog([
      ...OPENING,
      power('BLOCK_START BlockType=PLAY Entity=10 EffectCardId= EffectIndex=-1 Target=GameEntity SubOption=-1'),
      power('BLOCK_END'),
    ])
    expect(subOptionOnly.skippedLines).toBe(0)

    const weirdBlock = parsePowerLog([...OPENING, power('BLOCK_START nonsense')])
    expect(weirdBlock.skippedLines).toBe(1)

    const showOnPlayer = parsePowerLog([...OPENING, power('SHOW_ENTITY - Updating Entity=2 CardID=CS2_029')])
    expect(showOnPlayer.skippedGames).toBe(1)
  })

  it('Player 包的 CONTROLLER 记账 / SHOW 包 CONTROLLER 与手牌友方推断 / flush 的 full-CONTROLLER 臂', () => {
    const result = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('tag=CONTROLLER value=1'),
      power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      power('FULL_ENTITY - Creating ID=10 CardID='),
      power('tag=ZONE value=HAND'),
      power('SHOW_ENTITY - Updating Entity=10 CardID=CS2_029'),
      power('tag=CONTROLLER value=1'),
      power('tag=ZONE value=HAND'),
      power('FULL_ENTITY - Creating ID=11 CardID='),
      power('tag=ZONE value=DECK'),
    ])
    expect(result.skippedLines).toBe(0)
    expect(result.games[0]!.friendlyPlayerByShow).toBe(1)
  })

  it('LAST_CARD_PLAYED 的名字引用经 player-id 合并即时解析（延迟包回放）', () => {
    const result = parsePowerLog([
      ...OPENING,
      // 先注册名字（无实体 id）并挂一条延迟包
      power('TAG_CHANGE Entity=孤名 tag=HEALTH value=30'),
      // controller 已知（卡 10 → 1）：合并进 PlayerID=1 的既有引用 → 回放延迟包
      power('TAG_CHANGE Entity=孤名 tag=LAST_CARD_PLAYED value=10'),
    ])
    expect(result.skippedGames).toBe(0)
    expect(result.games[0]!.findEntityById(2)?.tags.get(TAG.HEALTH)).toBe(30)
  })
})

describe('解析器零散分支收尾', () => {
  it('ChoiceType 数字形态 / 未知 ChoiceType / 数字玩家的 Mulligan 包', () => {
    const numeric = parsePowerLog([
      ...OPENING,
      choicesLine('id=91 Player=玩家甲 TaskList= ChoiceType=1 CountMin=0 CountMax=1'),
      power('GameEntity EntityID=1'),
    ])
    expect(numeric.skippedLines).toBe(0)

    const unknownType = parsePowerLog([
      ...OPENING,
      choicesLine('id=92 Player=玩家甲 TaskList= ChoiceType=BOGUS CountMin=0 CountMax=1'),
    ])
    expect(unknownType.skippedLines).toBe(1)

    const numericPlayer = parsePowerLog([
      ...OPENING,
      choicesLine('id=93 Player=5 TaskList= ChoiceType=MULLIGAN CountMin=0 CountMax=2'),
      power('GameEntity EntityID=1'),
    ])
    expect(numericPlayer.skippedLines).toBe(0)
  })

  it('Mulligan 映射命中后 chosen 回执合并 player_id', () => {
    const result = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      power('FULL_ENTITY - Creating ID=10 CardID='),
      power('tag=CONTROLLER value=1'),
      choicesLine('id=94 Player=玩家甲 TaskList= ChoiceType=MULLIGAN CountMin=0 CountMax=2'),
      choicesLine('Entities[0]=[entityName id=10 zone=HAND]'),
      power('GameEntity EntityID=1'),
      chosenLine('id=94 Player=玩家甲 EntitiesCount=2'),
      chosenLine('Entities[0]=[entityName id=10 zone=HAND]'),
    ])
    expect(result.skippedLines).toBe(0)
    expect(result.games).toHaveLength(1)
  })

  it('未识别的 chosen 行 / 坏 chosen 实体行 / 坏 TAG_CHANGE 行', () => {
    const result = parsePowerLog([
      ...OPENING,
      chosenLine('完全未知的回执'),
      chosenLine('Entities[x]=不是括号'),
      power('TAG_CHANGE Entity=玩家甲 无效载荷'),
    ])
    expect(result.skippedLines).toBe(3)
  })

  it('SHOW 经 GameEntity 令牌与括号令牌解析', () => {
    const gameEntityToken = parsePowerLog([...OPENING, power('SHOW_ENTITY - Updating Entity=GameEntity CardID=CS2_029')])
    expect(gameEntityToken.skippedGames).toBe(1)

    const bracket = parsePowerLog([...OPENING, power('SHOW_ENTITY - Updating Entity=[entityName id=10 zone=HAND] CardID=CS2_029')])
    expect(bracket.skippedLines).toBe(0)
    expect((bracket.games[0]!.findEntityById(10) as CardEntity).revealed).toBe(true)
  })

  it('SHOW 手牌卡无 CONTROLLER 记录时保持启发式兜底', () => {
    const result = parsePowerLog([
      power('CREATE_GAME'),
      power('GameEntity EntityID=1'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      power('FULL_ENTITY - Creating ID=10 CardID='),
      power('SHOW_ENTITY - Updating Entity=10 CardID=CS2_029'),
      power('tag=ZONE value=HAND'),
    ])
    expect(result.games[0]!.friendlyPlayerByShow).toBeNull()
  })

  it('双名字延迟包：一条解析一条留存 → 局末丢弃', () => {
    const result = parsePowerLog([
      ...OPENING,
      // 占位名让名字表大小 ≠ 1，避免单名字推断抢先解析
      power('TAG_CHANGE Entity=占位 tag=HEALTH value=20'),
      power('TAG_CHANGE Entity=玩家甲 tag=HEALTH value=25'),
      power('TAG_CHANGE Entity=玩家乙 tag=HEALTH value=26'),
      power('TAG_CHANGE Entity=玩家甲 tag=ENTITY_ID value=2'),
    ])
    expect(result.skippedGames).toBe(1)
  })

  it('坏 TAG_CHANGE 正则跳行', () => {
    const result = parsePowerLog([...OPENING, power('TAG_CHANGE Entity=玩家甲 无效载荷')])
    expect(result.skippedLines).toBeGreaterThanOrEqual(1)
  })
})

describe('解析器最后分支', () => {
  it('真正的旁观者横幅（无方法前缀）跳行', () => {
    const result = parsePowerLog([
      ...OPENING,
      'D 10:00:00.0 ====================================== SPECTATOR MODE',
    ])
    expect(result.skippedLines).toBe(1)
  })

  it('非 MULLIGAN 包由后续 Power 操作 flush', () => {
    const result = parsePowerLog([
      ...OPENING,
      choicesLine('id=95 Player=玩家甲 TaskList= ChoiceType=GENERAL CountMin=1 CountMax=2'),
      power('GameEntity EntityID=1'),
    ])
    expect(result.skippedLines).toBe(0)
  })

  it('SHOW/HIDE/CHANGE 用未解析的名字令牌 → 整局丢弃', () => {
    const hide = parsePowerLog([...OPENING, power('HIDE_ENTITY - Entity=无名氏 tag=ZONE value=DECK')])
    expect(hide.skippedGames).toBe(1)
  })

  it('手牌 SHOW 带 CONTROLLER 且此前已解析 → 二次解析被挡', () => {
    const result = parsePowerLog([
      ...OPENING,
      power('SHOW_ENTITY - Updating Entity=10 CardID=EX1_015'),
      power('tag=CONTROLLER value=1'),
      power('tag=ZONE value=HAND'),
    ])
    expect(result.games[0]!.friendlyPlayerByShow).toBe(1)
  })
})
