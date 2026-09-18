/**
 * 状态序列化（含合法可见信息过滤）。
 *
 * 隐藏信息是硬约束（代码级断言）：对手手牌只暴露数量，绝不暴露具体卡牌——
 * 带 CardID 的对手手牌实体直接拒绝序列化（fail loud）。这一层是整个
 * 教练的合规底线，agentic 工具层（tools/）也只暴露本层产物。
 */
import type { CardDatabase } from './cards.ts'
import type { GameEntityModel, PlayerEntity } from './entities.ts'
import { GAME_TAG, VALUE_ENUMS } from './enums.generated.ts'
import { CARDTYPE_HERO, TAG, ZONE } from './tags.ts'

function GAME_TAG_VALUE(name: string): number {
  const value = GAME_TAG[name]
  /* v8 ignore next -- 生成表是冻结数据，常量表内的名字必存在；缺失即生成器缺陷 */
  if (value === undefined) throw new Error(`unknown GameTag ${name}`)
  return value
}

/* v8 ignore next -- 生成的 VALUE_ENUMS 恒含 CardType 表 */
const CARD_TYPE_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(VALUE_ENUMS.CardType ?? {}).map(([name, value]) => [value, name]),
)

/** 关键词 flags（顺序影响展示）。 */
const FLAG_TAGS: Array<[string, number]> = [
  ['嘲讽', GAME_TAG_VALUE('TAUNT')],
  ['圣盾', GAME_TAG_VALUE('DIVINE_SHIELD')],
  ['风怒', GAME_TAG_VALUE('WINDFURY')],
  ['剧毒', GAME_TAG_VALUE('POISONOUS')],
  ['复生', GAME_TAG_VALUE('REBORN')],
  ['冻结', GAME_TAG_VALUE('FROZEN')],
  ['潜行', GAME_TAG_VALUE('STEALTH')],
  ['吸血', GAME_TAG_VALUE('LIFESTEAL')],
  ['冲锋', GAME_TAG_VALUE('CHARGE')],
  ['突袭', GAME_TAG_VALUE('RUSH')],
  ['免疫', GAME_TAG_VALUE('IMMUNE')],
  ['休眠', GAME_TAG_VALUE('DORMANT')],
  ['无法攻击', GAME_TAG_VALUE('CANT_ATTACK')],
  ['已尽', GAME_TAG_VALUE('EXHAUSTED')],
  ['不可被法术指定', GAME_TAG_VALUE('CANT_BE_TARGETED_BY_SPELLS')],
]

/** 单张卡牌的可见视图（实体 + 卡库数据合成）。 */
export interface CardView {
  cardId: string | null
  name: string
  cost: number | null
  attack: number | null
  health: number | null
  flags: string[]
  text: string
  damaged: number | null
  cardType: string | null
  cardClass: string | null
}

/** 单个玩家的可见视图（对手手牌只见数量）。 */
export interface PlayerView {
  name: string
  hero: CardView | null
  health: number
  armor: number
  mana: number
  maxMana: number
  /** 己方是列表；对手是数量（隐藏信息约束）。 */
  hand: CardView[] | { count: number }
  board: CardView[]
  deckCount: number
  fatigue: number
  playedCards: CardView[]
  secrets: number
  possibleSecrets: string[]
}

/** 对局快照：回合、当前玩家与各玩家视图（合法可见信息）。 */
export interface GameSnapshot {
  turn: number
  currentPlayerId: number | null
  players: Record<string, PlayerView>
}

/** 隐藏信息违规：对手手牌实体带 CardID，拒绝序列化。 */
export class HiddenInfoViolationError extends Error {}

function extractFlags(tags: Map<number, number>): string[] {
  const flags: string[] = []
  for (const [label, tag] of FLAG_TAGS) {
    if (tags.get(tag)) flags.push(label)
  }
  return flags
}

function entityToCardView(
  entity: { cardId?: string | null; tags: Map<number, number> },
  db: CardDatabase | null,
): CardView {
  const tags = entity.tags
  const cardId = (entity as { cardId?: string | null }).cardId ?? null
  let name = cardId ?? '未知卡牌'
  let text = ''
  let cardClass = ''
  if (cardId && db) {
    const card = db.get(cardId)
    if (card) {
      name = card.name
      text = card.text
      cardClass = card.cardClass
    }
  }
  const ct = tags.get(TAG.CARDTYPE)
  let cardType: string | null = null
  if (ct !== undefined) cardType = cardTypeName(ct)
  return {
    cardId,
    name,
    cost: tags.get(TAG.COST) ?? null,
    attack: tags.get(TAG.ATK) ?? null,
    health: tags.get(TAG.HEALTH) ?? null,
    flags: extractFlags(tags),
    text,
    damaged: tags.get(TAG.DAMAGE) || null,
    cardType,
    cardClass: cardClass || null,
  }
}

/** CardType 数字 → 枚举名（未知值回退 null）。 */
function cardTypeName(value: number): string | null {
  return CARD_TYPE_NAMES[value] ?? null
}

function controlledBy(entities: ReturnType<GameEntityModel['inZone']>, pid: number) {
  return entities.filter(e => e.tags.get(TAG.CONTROLLER) === pid)
}

/**
 * 从对局推断友方玩家 id：客户端只对本地玩家手牌写 CardID，
 * "手牌含 CardID 的玩家"即友方；空手牌/双方都有（观战）返回 null。
 * @param game - 对局实体树。
 * @returns 友方玩家 id；无法判定时为 null。
 */
export function detectFriendlyPlayerId(game: GameEntityModel): number | null {
  const candidates: number[] = []
  for (const player of game.players) {
    const hand = controlledBy(game.inZone(ZONE.HAND), player.playerId)
    if (hand.some(e => (e as { cardId?: string | null }).cardId)) {
      candidates.push(player.playerId)
    }
  }
  const only = candidates[0]
  return candidates.length === 1 && only !== undefined ? only : null
}

/**
 * 友方检测：首个手牌 SHOW_ENTITY 的控制者 + 启发式兜底。
 * @param game - 对局实体树。
 * @returns 友方玩家 id；无法判定时为 null。
 */
export function calibrateFriendlyPlayer(game: GameEntityModel): number | null {
  if (game.friendlyPlayerByShow !== null) return game.friendlyPlayerByShow
  return detectFriendlyPlayerId(game)
}

/**
 * 把 Game 实体树序列化成合法可见快照（对手手牌只见数量）。
 * @param game - 对局实体树。
 * @param friendlyPlayerId - 我方玩家 id（决定手牌是否展开）。
 * @param db - 卡牌知识库（提供名称/文本/职业）；缺省不查询。
 * @returns 对局快照。
 */
export function serializeGame(
  game: GameEntityModel,
  friendlyPlayerId: number,
  db: CardDatabase | null = null,
): GameSnapshot {
  const playersView: Record<string, PlayerView> = {}

  const turn = game.tags.get(TAG.TURN) ?? 0
  let currentPlayerId = game.tags.get(TAG.CURRENT_PLAYER) ?? null
  if (currentPlayerId === null) {
    for (const player of game.players) {
      if (player.tags.get(TAG.CURRENT_PLAYER) === 1) {
        currentPlayerId = player.playerId
        break
      }
    }
  }

  for (const player of game.players) {
    const pid = player.playerId
    const isFriendly = pid === friendlyPlayerId

    const heroEntityId = player.tags.get(TAG.HERO_ENTITY)
    let hero: CardView | null = null
    let health = nonzero(player.tags.get(TAG.HEALTH), 30)
    const armor = player.tags.get(TAG.ARMOR) ?? 0
    const mana = player.tags.get(TAG.RESOURCES) ?? 0
    const maxMana = nonzero(player.tags.get(TAG.MAXRESOURCES), 10)

    if (heroEntityId !== undefined) {
      const heroEntity = game.findEntityById(heroEntityId)
      if (heroEntity && heroEntity !== game) {
        hero = entityToCardView(heroEntity, db)
        const entHp = heroEntity.tags.get(TAG.HEALTH)
        if (entHp !== undefined) {
          // 英雄血量以实体 tag 为准（可为 0，不兜底）
          health = entHp - (heroEntity.tags.get(TAG.DAMAGE) ?? 0)
        }
      }
    }

    const handEntities = controlledBy(game.inZone(ZONE.HAND), pid)
    let hand: CardView[] | { count: number }
    if (isFriendly) {
      hand = handEntities.map(e => entityToCardView(e, db))
    } else {
      assertNoOpponentHandLeak(handEntities, pid)
      hand = { count: handEntities.length }
    }

    const board = controlledBy(game.inZone(ZONE.PLAY), pid)
      .filter(e => e.tags.get(TAG.CARDTYPE) !== CARDTYPE_HERO)
      .map(e => entityToCardView(e, db))

    const deckCount = controlledBy(game.inZone(ZONE.DECK), pid).length
    const fatigue = player.tags.get(TAG.FATIGUE) ?? 0
    const playedCards = controlledBy(game.inZone(ZONE.GRAVEYARD), pid).map(e =>
      entityToCardView(e, db),
    )
    const secrets = controlledBy(game.inZone(ZONE.SECRET), pid).length

    let possibleSecrets: string[] = []
    if (!isFriendly && secrets > 0 && db && hero?.cardClass) {
      possibleSecrets = secretPool(db, hero.cardClass)
    }

    playersView[String(pid)] = {
      name: playerName(player, pid),
      hero,
      health,
      armor: armor || 0,
      mana,
      maxMana,
      hand,
      board,
      deckCount,
      fatigue,
      playedCards,
      secrets,
      possibleSecrets,
    }
  }

  return { turn, currentPlayerId, players: playersView }
}

/** 0 视同未设置，回退默认值。 */
function nonzero(value: number | undefined, fallback: number): number {
  return value ? value : fallback
}

function playerName(player: PlayerEntity, pid: number): string {
  return player.name ?? `玩家${pid}`
}

/** 隐藏信息代码级防线：对手手牌实体带 CardID → 拒绝输出。 */
function assertNoOpponentHandLeak(
  entities: Array<{ id: number; cardId?: string | null }>,
  playerId: number,
): void {
  for (const entity of entities) {
    if (entity.cardId) {
      throw new HiddenInfoViolationError(
        `隐藏信息违规：玩家 ${playerId}（对手）的手牌实体 ${entity.id} 带 CardID=${JSON.stringify(entity.cardId)}，隐藏信息可能泄露。拒绝序列化。`,
      )
    }
  }
}

// ── 发布契约（snake_case，与 Tauri 前端逐字段一致） ─────

/** 卡牌视图的发布契约（snake_case，与前端逐字段一致）。 */
export interface CardViewContract {
  card_id: string | null
  name: string
  cost: number | null
  attack: number | null
  health: number | null
  flags: string[]
  text: string
  damaged: number | null
  card_type: string | null
  card_class: string | null
}

/** 玩家视图的发布契约（snake_case，与前端逐字段一致）。 */
export interface PlayerViewContract {
  name: string
  health: number
  armor: number
  mana: number
  max_mana: number
  hand: CardViewContract[] | { count: number }
  board: CardViewContract[]
  deck_count: number
  fatigue: number
  played_cards: CardViewContract[]
  secrets: number
  possible_secrets: string[]
  /** 发布层注入（publishGameState）的契约键。 */
  draw_odds?: { one_copy_next_draw: number; two_copy_next_draw: number }
}

/** 对局快照的发布契约（snake_case，与前端逐字段一致）。 */
export interface SnapshotContract {
  turn: number
  current_player_id: number | null
  players: Record<string, PlayerViewContract>
}

/**
 * 卡牌视图 → 发布契约（字段名转 snake_case，damaged/card_type 归一 null）。
 * @param view - 内部卡牌视图。
 * @returns 发布契约对象。
 */
export function cardViewToContract(view: CardView): CardViewContract {
  return {
    card_id: view.cardId,
    name: view.name,
    cost: view.cost,
    attack: view.attack,
    health: view.health,
    flags: view.flags,
    text: view.text,
    damaged: view.damaged || null,
    card_type: view.cardType || null,
    card_class: view.cardClass || null,
  }
}

/**
 * 玩家视图 → 发布契约（不含 draw_odds，由发布层注入）。
 * @param view - 内部玩家视图。
 * @returns 发布契约对象。
 */
export function playerViewToContract(view: PlayerView): PlayerViewContract {
  return {
    name: view.name,
    health: view.health,
    armor: view.armor,
    mana: view.mana,
    max_mana: view.maxMana,
    hand: Array.isArray(view.hand) ? view.hand.map(cardViewToContract) : view.hand,
    board: view.board.map(cardViewToContract),
    deck_count: view.deckCount,
    fatigue: view.fatigue,
    played_cards: view.playedCards.map(cardViewToContract),
    secrets: view.secrets,
    possible_secrets: view.possibleSecrets,
  }
}

/**
 * 对局快照 → 发布契约。
 * @param snapshot - 内部对局快照。
 * @returns 发布契约对象。
 */
export function snapshotToContract(snapshot: GameSnapshot): SnapshotContract {
  const players: Record<string, PlayerViewContract> = {}
  for (const [pid, view] of Object.entries(snapshot.players)) {
    players[pid] = playerViewToContract(view)
  }
  return {
    turn: snapshot.turn,
    current_player_id: snapshot.currentPlayerId,
    players,
  }
}

/** 奥秘候选池（标准年卡包内该职业的奥秘，按费用升序）。 */
const STANDARD_SETS = new Set([
  'CORE',
  'EMERALD_DREAM',
  'THE_LOST_CITY',
  'TIME_TRAVEL',
  'CATACLYSM',
  'ESCAPEFROM_VIOLET_HOLD',
])

function secretPool(db: CardDatabase, cardClass: string): string[] {
  return db
    .iterCards()
    .filter(
      c =>
        c.type === 'SPELL' &&
        c.cardClass === cardClass &&
        STANDARD_SETS.has(c.cardSet) &&
        c.text.includes('奥秘'),
    )
    .sort((a, b) => a.cost - b.cost)
    .map(c => c.name)
}
