/**
 * 实体模型：对局实体树（游戏/玩家/卡牌），只保留教练消费的字段。
 * GAME_RESET 只重置 card_id/revealed。
 */
import { TAG, ZONE } from './tags.ts'

/** 实体标签表：tag 枚举值 → 标签值。 */
export type Tags = Map<number, number>

/** 卡牌实体：对局中的一张卡（手牌/场面/牌库等），保留教练消费的字段。 */
export class CardEntity {
  /** 实体类别标记，固定为 'card'。 */
  readonly kind = 'card' as const
  /** 实体 id（日志中的 EntityID）。 */
  readonly id: number
  /** 卡牌 id（HearthstoneJSON CardID）；未揭示时为 null。 */
  cardId: string | null
  /** 是否已通过 SHOW_ENTITY 揭示。 */
  revealed = false
  /** 实体标签表。 */
  readonly tags: Tags

  constructor(id: number, cardId: string | null, tags: Tags) {
    this.id = id
    this.cardId = cardId
    this.tags = tags
  }

  /**
   * 读取实体当前所在区域。
   * @returns ZONE 标签值；缺失时为 ZONE.INVALID。
   */
  zone(): number {
    return this.tags.get(TAG.ZONE) ?? ZONE.INVALID
  }

  /**
   * SHOW_ENTITY：揭示 + 合并 tags。
   * @param cardId - 揭示出的卡牌 id。
   * @param tags - 本次揭示携带的增量标签。
   */
  reveal(cardId: string, tags: Tags): void {
    this.revealed = true
    this.cardId = cardId
    mergeTags(this.tags, tags)
  }

  /** HIDE_ENTITY：只撤销揭示（区域变化由后续 TAG_CHANGE 驱动）。 */
  hide(): void {
    this.revealed = false
  }

  /**
   * CHANGE_ENTITY：变换卡牌。原 CardID 缺失是导出级错误（整局丢弃）。
   * @param cardId - 变换后的卡牌 id。
   * @param tags - 变换携带的增量标签。
   */
  change(cardId: string, tags: Tags): void {
    if (!this.cardId) {
      throw new GameExportError(
        `CHANGE_ENTITY ${this.id} to ${cardId} with no previous known CardID.`,
      )
    }
    this.cardId = cardId
    mergeTags(this.tags, tags)
  }

  /** GAME_RESET：还原到未揭示状态。 */
  reset(): void {
    this.cardId = null
    this.revealed = false
  }
}

/** 玩家实体：对局中的一名玩家。 */
export class PlayerEntity {
  /** 实体类别标记，固定为 'player'。 */
  readonly kind = 'player' as const
  /** 实体 id（日志中的 EntityID）。 */
  readonly id: number
  /** 玩家 id（日志中的 PlayerID）。 */
  readonly playerId: number
  /** 战网账号 id 高 32 位（日志 GameAccountId 的 hi）。 */
  readonly hi: number
  /** 战网账号 id 低 32 位（日志 GameAccountId 的 lo；AI 玩家为 0）。 */
  readonly lo: number
  /** 玩家名；未出现时为 null。 */
  readonly name: string | null = null
  /** 实体标签表。 */
  readonly tags: Tags = new Map()

  constructor(id: number, playerId: number, hi: number, lo: number) {
    this.id = id
    this.playerId = playerId
    this.hi = hi
    this.lo = lo
  }

  /**
   * 读取玩家当前所在区域。
   * @returns ZONE 标签值；缺失时为 ZONE.INVALID。
   */
  zone(): number {
    return this.tags.get(TAG.ZONE) ?? ZONE.INVALID
  }
}

/** 游戏实体：对局实体树的根，聚合玩家与全部实体。 */
export class GameEntityModel {
  /** 实体类别标记，固定为 'game'。 */
  readonly kind = 'game' as const
  /** 游戏实体 id。 */
  readonly id: number
  /** 游戏级标签表。 */
  readonly tags: Tags = new Map()
  /** 已注册的玩家实体列表。 */
  readonly players: PlayerEntity[] = []
  /** 全部实体（含游戏自身），按实体 id 索引。 */
  readonly entities = new Map<number, CardEntity | PlayerEntity | GameEntityModel>()
  /** 友方玩家检测的内联结果（首个手牌 SHOW_ENTITY 的控制者）。 */
  friendlyPlayerByShow: number | null = null

  constructor(id: number) {
    this.id = id
    this.entities.set(id, this)
  }

  /**
   * 列出指定区域内的非游戏实体。
   * @param zone - ZONE 标签值。
   * @returns 该区域内的卡牌与玩家实体。
   */
  inZone(zone: number): Array<CardEntity | PlayerEntity> {
    const out: Array<CardEntity | PlayerEntity> = []
    for (const entity of this.entities.values()) {
      if (entity.kind === 'game') continue
      if (entity.zone() === zone) out.push(entity)
    }
    return out
  }

  /**
   * 按实体 id 查找实体。
   * @param id - 实体 id。
   * @returns 命中的实体；不存在时为 undefined。
   */
  findEntityById(id: number): CardEntity | PlayerEntity | GameEntityModel | undefined {
    return this.entities.get(id)
  }

  /**
   * 注册新实体（玩家同时进入 players 列表）。
   * @param entity - 要注册的卡牌或玩家实体。
   */
  registerEntity(entity: CardEntity | PlayerEntity): void {
    this.entities.set(entity.id, entity)
    if (entity instanceof PlayerEntity) this.players.push(entity)
  }

  /** GAME_RESET：所有卡牌实体回到未揭示状态。 */
  reset(): void {
    for (const entity of this.entities.values()) {
      if (entity instanceof CardEntity) entity.reset()
    }
  }
}

/** 导出级错误：对局数据不完整时整局丢弃。 */
export class GameExportError extends Error {}

function mergeTags(target: Tags, source: Tags): void {
  for (const [tag, value] of source) target.set(tag, value)
}
