/**
 * Power.log 解析器：单遍解析 + 实体树构建（解析顺序与导出顺序同为
 * 深度优先，实体语义与黄金快照一致）。
 *
 * 行为约束（test/parity.test.ts 黄金快照钉死）：
 * - 每局独立解析（CREATE_GAME 边界；玩家 id 跨局会重排）
 * - 坏行：跳过计数，不影响后续行（skippedLines，行级错误）
 * - 导出级错误（CHANGE_ENTITY 无原卡 / 操作指向未建实体 / 玩家引用
 *   无实体 id）：整局丢弃（skippedGames）
 * - 只处理 GameState.DebugPrintPower / GameState.DebugPrintGame；
 *   PowerTaskList.* 是重复流，无回调天然忽略（国服日志的语义）
 */
import {
  CardEntity,
  GameEntityModel,
  GameExportError,
  PlayerEntity,
} from './entities.ts'
import { PlayerManager, PlayerReference } from './playerManager.ts'
import { BLOCK_TYPE, CHOICE_TYPE, GAME_TAG, POWER_OPCODES } from './enums.generated.ts'
import { TAG, parseTag } from './tags.ts'

const GAME_ENTITY = 'GameEntity'
const UNKNOWN_HUMAN_PLAYER = 'UNKNOWN HUMAN PLAYER'

// Power.log 行格式正则（锚点与分组语义是黄金快照行为的一部分，勿随意改）
const _E = `(${GAME_ENTITY}|${UNKNOWN_HUMAN_PLAYER}|\\[.+\\]|\\d+|.+)`
const TIMESTAMP_RE = /^([DWE]) ([\d:.]+) (.+)$/
const POWERLOG_LINE_RE = /^([^(]+)\(\) - (.+)$/
const SPECTATOR_TOKEN = '=================='
const ENTITY_RE = /\[.*\s*id=(\d+)\s*.*]/
const GAME_ENTITY_RE = /^GameEntity EntityID=(\d+)/
const PLAYER_ENTITY_RE =
  /^Player EntityID=(\d+) PlayerID=(\d+) GameAccountId=\[hi=(\d+) lo=(\d+)\]$/
const TAG_VALUE_RE = /^tag=(\w+) value=(\w+)$/
const BLOCK_START_SUBOPTION_RE = new RegExp(
  `^BLOCK_START BlockType=(\\w+) Entity=${_E} EffectCardId=(.*) EffectIndex=(-1|\\d+) Target=${_E} SubOption=(-1|\\d+)$`,
)
const BLOCK_START_TRIGGER_RE = new RegExp(
  `^BLOCK_START BlockType=(\\w+) Entity=${_E} EffectCardId=(.*) EffectIndex=(-1|\\d+) Target=${_E} SubOption=(-1|\\d+) TriggerKeyword=(\\w+)$`,
)
const BLOCK_START_PLAIN_RE = new RegExp(
  `^BLOCK_START BlockType=(\\w+) Entity=${_E} EffectCardId=(.*) EffectIndex=(-1|\\d+) Target=${_E}$`,
)
const ACTION_START_RE = new RegExp(
  `^ACTION_START SubType=(\\w+) Entity=${_E} EffectCardId=(.*) EffectIndex=(-1|\\d+) Target=${_E}$`,
)
const ACTION_START_OLD_RE = new RegExp(
  `^ACTION_START Entity=${_E} (?:SubType|BlockType)=(\\w+) Index=(-1|\\d+) Target=${_E}$`,
)
const BLOCK_END_RE = /^(?:ACTION|BLOCK)_END$/
const FULL_ENTITY_CREATE_RE = /^FULL_ENTITY - Creating ID=(\d+) CardID=(\w+)?$/
const FULL_ENTITY_UPDATE_RE = new RegExp(`^FULL_ENTITY - Updating ${_E} CardID=(\\w+)?$`)
const SHOW_ENTITY_RE = new RegExp(`^SHOW_ENTITY - Updating Entity=${_E} CardID=(\\w+)$`)
const HIDE_ENTITY_RE = new RegExp(`^HIDE_ENTITY - Entity=${_E} tag=(\\w+) value=(\\w+)$`)
const CHANGE_ENTITY_RE = new RegExp(`^CHANGE_ENTITY - Updating Entity=${_E} CardID=(\\w+)$`)
const TAG_CHANGE_RE = new RegExp(
  `^TAG_CHANGE Entity=${_E} tag=(\\w+) value=(\\w+) ?(DEF CHANGE)?`,
)
const GAME_PLAYER_META_RE = /^PlayerID=(\d+), PlayerName=(.*)$/
// Choices（DebugPrintEntityChoices）：mulligan 名字注册的解析来源
const CHOICES_CHOICE_RE = new RegExp(
  `^id=(\\d+) Player=${_E} TaskList=(\\d+)? ChoiceType=(\\w+) CountMin=(\\d+) CountMax=(\\d+)$`,
)
const CHOICES_SOURCE_RE = new RegExp(`^Source=${_E}$`)
const CHOICES_ENTITIES_RE = /^Entities\[(\d+)\]=(\[.+\])$/
const CHOSEN_HEADER_RE = new RegExp(`^id=(\\d+) Player=${_E} EntitiesCount=(\\d+)$`)
const CHOSEN_ENTITIES_RE = new RegExp(`^Entities\\[(\\d+)\\]=${_E}$`)

/** 解析结果：按 CREATE_GAME 边界切出的对局实体树与跳过计数。 */
export interface ParseResult {
  games: GameEntityModel[]
  /** 坏行计数（跳过，不影响后续行）。 */
  skippedLines: number
  /** 整局丢弃数。 */
  skippedGames: number
}

/** 行级错误：跳过该行、局继续。 */
export class LineError extends Error {}

/**
 * 正则捕获组按必选消费：命中正则即假定必选组存在，缺失 = 行格式坏
 * （与 LineError 同语义，调用方按"跳过该行"处理）。
 * @param m - 已命中的正则执行结果。
 * @param index - 捕获组下标。
 * @param context - 诊断上下文（行种类名）。
 * @returns 该捕获组的精确 `string`。
 */
function capture(m: RegExpExecArray, index: number, context: string): string {
  const value = m[index]
  /* v8 ignore next -- 命中的正则其必选捕获组恒存在；缺失即生成器/正则缺陷 */
  if (value === undefined) throw new LineError(`missing capture group ${index} in ${context}`)
  return value
}
/** 导出级错误：整局丢弃。 */
export { GameExportError }

/**
 * 真实 Power.log 行带 "[Power] " 频道前缀，解析前剥离。
 * @param line - 原始日志行。
 * @returns 剥离前缀后的行；不含前缀时原样返回。
 */
export function stripPowerPrefix(line: string): string {
  const idx = line.indexOf('[Power] ')
  return idx >= 0 ? line.slice(idx + '[Power] '.length) : line
}

/**
 * CREATE_GAME 对局边界（只认 GameState 频道；国服 PowerTaskList 重复行不算）。
 * @param line - 原始日志行。
 * @returns 是对局边界行返回 true。
 */
export function isCreateGameLine(line: string): boolean {
  return line.includes('CREATE_GAME') && line.includes('GameState.DebugPrintPower')
}

/** 待 flush 的 tag= 行归属（最近一次声明的包）。 */
type Pending =
  | { kind: 'game'; game: GameEntityModel }
  | { kind: 'player'; player: PlayerEntity }
  | { kind: 'full'; card: CardEntity }
  | { kind: 'show'; card: CardEntity; cardId: string }
  | null

/** 单局解析器：parsePowerLog 在 CREATE_GAME 边界处一局一建。 */
export class GameParser {
  /** 当前对局实体树；beginGame 前为 null。 */
  game: GameEntityModel | null = null
  private readonly manager = new PlayerManager()
  private pending: Pending = null
  private pendingTags: Array<[number, number]> = []
  private blockDepth = 0
  private creatingGame = false
  /** 友方玩家内联检测状态。 */
  private readonly controllerMap = new Map<number, number>()
  private aiPlayerId: number | null = null
  private nonAiPlayerIds: number[] = []
  private friendlyResolved = false
  /**
   * TAG_CHANGE 的延迟应用（有序队列）：实体令牌是尚未解析的玩家引用时，
   * 引用获得实体 id 的时刻（ENTITY_ID tag / player_id 合并）按队列顺序
   * 回放，局末仍未解析则整局丢弃。
   */
  private readonly deferredTagChanges: Array<{
    ref: PlayerReference
    tag: number
    value: number
  }> = []

  constructor() {
    this.manager.onEntityIdAssigned = () =>{  this.flushResolvable() }
  }

  /** CREATE_GAME 行：开局。 */
  beginGame(): void {
    this.game = new GameEntityModel(1)
    this.pending = { kind: 'game', game: this.game }
    this.creatingGame = true
  }

  /**
   * 行级入口；抛 LineError=跳行，GameExportError=丢局。
   * @param line - 已剥离频道前缀的日志行。
   */
  readLine(line: string): void {
    const tsMatch = TIMESTAMP_RE.exec(line)
    if (!tsMatch) throw new LineError('not a timestamped line')

    const rest = capture(tsMatch, 3, 'timestamped line')
    if (rest.startsWith(SPECTATOR_TOKEN)) {
      throw new LineError('spectator mode unsupported')
    }
    const lineMatch = POWERLOG_LINE_RE.exec(rest)
    if (!lineMatch) return // 非方法行：静默忽略

    const method = capture(lineMatch, 1, 'power log line')
    const msg = capture(lineMatch, 2, 'power log line').trim()

    /* v8 ignore next -- parsePowerLog 只在 CREATE_GAME 边界后调用 readLine，game 恒已建立 */
    if (!this.game && !msg.includes('CREATE_GAME')) return

    if (method === 'GameState.DebugPrintPower') this.handleData(msg)
    else if (method === 'GameState.DebugPrintGame') this.handleGameMeta(msg)
    else if (method === 'GameState.DebugPrintEntityChoices') this.handleChoices(msg)
    else if (method === 'GameState.DebugPrintEntitiesChosen') this.handleChosen(msg)
    // 其余方法（Options/SendChoices/PowerTaskList...）：无实体树副作用，忽略
  }

  // ── Choices（mulligan 名字注册：玩家名→实体 id 的关键解析路径） ────────

  private choicePacket: {
    id: number
    player: number | PlayerReference | null
    type: number
    choices: number[]
  } | null = null
  private chosenPacket: {
    id: number
    player: number | PlayerReference | null
    count: number
    choices: number[]
  } | null = null
  private readonly mulliganChoices = new Map<number, number>() // choiceId → playerId

  private handleChoices(data: string): void {
    if (data.startsWith('id=')) {
      const m = CHOICES_CHOICE_RE.exec(data)
      if (!m) throw new LineError(`bad choice header: ${data.slice(0, 60)}`)
      const typeText = m[4]
      /* v8 ignore next -- ChoiceType 是 CHOICES_CHOICE_RE 的必选捕获组，命中即存在 */
      if (typeText === undefined) throw new LineError(`bad choice header: ${data.slice(0, 60)}`)
      const typeValue = /^\d+$/.test(typeText)
        ? Number(typeText)
        : CHOICE_TYPE[typeText] ?? (() => {
          throw new LineError(`unknown ChoiceType ${typeText}`)
        })()
      this.choicePacket = {
        id: Number(capture(m, 1, 'choice header')),
        player: this.parseEntityOrPlayer(capture(m, 2, 'choice header')),
        type: typeValue,
        choices: [],
      }
      return
    }
    if (data.startsWith('Source=')) {
      const m = CHOICES_SOURCE_RE.exec(data)
      /* v8 ignore next -- _E 的 .+ 兜底臂使 Source= 行永不失配 */
      if (!m) throw new LineError(`bad choice source: ${data.slice(0, 60)}`)
      this.parseEntityOrPlayer(capture(m, 1, 'choice source')) // 引用注册副作用（guess 触发）
      return
    }
    if (data.startsWith('Entities[')) {
      const m = CHOICES_ENTITIES_RE.exec(data)
      if (!m) throw new LineError(`bad choice entity: ${data.slice(0, 60)}`)
      const entityToken = capture(m, 2, 'choice entity')
      const id = this.parseEntityId(entityToken)
      /* v8 ignore start -- CHOICES_ENTITIES_RE 的实体令牌恒为括号形式，parseEntityId 必返回数字 */
      const entityId = typeof id === 'number' ? id : id.entityId
      if (entityId === null) {
        throw new LineError(`missing choice entity: ${entityToken.slice(0, 40)}`)
      }
      /* v8 ignore stop */
      this.choicePacket?.choices.push(entityId)
      return
    }
    throw new LineError(`unhandled entity choice: ${data.slice(0, 60)}`)
  }

  private handleChosen(data: string): void {
    if (data.startsWith('id=')) {
      const m = CHOSEN_HEADER_RE.exec(data)
      if (!m) throw new LineError(`bad chosen header: ${data.slice(0, 60)}`)
      const player = this.parseEntityOrPlayer(capture(m, 2, 'chosen header'))
      const chosenId = Number(capture(m, 1, 'chosen header'))
      this.chosenPacket = { id: chosenId, player, count: Number(capture(m, 3, 'chosen header')), choices: [] }
      // mulligan 回执：名字 × choiceId → player_id（断线重连时的兜底解析）
      const mapped = this.mulliganChoices.get(chosenId)
      if (mapped !== undefined && player instanceof PlayerReference && player.name !== null) {
        this.manager.createOrUpdatePlayer({ name: player.name, playerId: mapped })
      }
      return
    }
    if (data.startsWith('Entities[')) {
      const m = CHOSEN_ENTITIES_RE.exec(data)
      if (!m) throw new LineError(`bad chosen entity: ${data.slice(0, 60)}`)
      const id = this.parseEntityOrPlayer(capture(m, 2, 'entities chosen'))
      if (typeof id !== 'number') {
        throw new LineError(`missing entity chosen: ${data.slice(0, 60)}`)
      }
      const packet = this.chosenPacket
      if (!packet) throw new LineError('entity chosen outside of choice packet')
      packet.choices.push(id)
      if (packet.choices.length > packet.count) {
        throw new LineError(`too many choices (expected ${packet.count})`)
      }
      return
    }
    throw new LineError(`unhandled entities chosen: ${data.slice(0, 60)}`)
  }

  /**
   * ps.flush() 等价：每个 Power 操作码 / GameEntity / Player 行触发。
   * MULLIGAN choice 包在此用"卡牌控制器"反查玩家 id，完成名字→实体解析
   * （PlayerOne/PlayerTwo 引用获得 player_id → 合并到 CREATE_GAME 实体）。
   */
  private flushChoices(): void {
    const packet = this.choicePacket
    this.choicePacket = null
    this.chosenPacket = null
    if (!packet) return
    if (packet.type !== CHOICE_TYPE.MULLIGAN) return
    if (!(packet.player instanceof PlayerReference)) return
    const player = packet.player
    if (player.entityId !== null || !player.name) return
    let resolved: PlayerReference = player
    for (const choice of packet.choices) {
      const controller = this.manager.getControllerByEntityId(choice)
      if (controller === undefined) {
        throw new LineError(`unknown entity id in choice: ${choice}`)
      }
      resolved = this.manager.createOrUpdatePlayer({ name: player.name, playerId: controller })
    }
    if (resolved.playerId !== null) {
      this.mulliganChoices.set(packet.id, resolved.playerId)
    }
  }

  /** parse_entity_or_player：-1 → null；数字/GameEntity/括号 → id；名字 → 引用。 */
  private parseEntityOrPlayer(entity: string): number | PlayerReference | null {
    if (entity === '-1') return null
    return this.parseEntityId(entity)
  }

  /** 局末收尾：残留 pending 一并 flush；未解析的延迟 TAG_CHANGE → 丢局。 */
  finish(): void {
    this.flush()
    if (this.deferredTagChanges.length > 0) {
      throw new GameExportError(
        `entity id not available for ${this.deferredTagChanges.length} deferred tag change(s)`,
      )
    }
  }

  // ── GameState.DebugPrintGame ─────────────────────────────────────────────

  private handleGameMeta(data: string): void {
    if (data.startsWith('PlayerID=')) {
      const m = GAME_PLAYER_META_RE.exec(data)
      if (!m) throw new LineError(`bad PlayerID meta: ${data}`)
      this.manager.createOrUpdatePlayer({ name: capture(m, 2, 'player meta'), playerId: Number(capture(m, 1, 'player meta')) })
      return
    }
    const eq = data.indexOf('=')
    if (eq < 0 || !/^\d+$/.test(data.slice(eq + 1).trim())) {
      throw new LineError(`bad game meta: ${data}`)
    }
    // GameType/FormatType 等：数值校验后丢弃（game_meta 不被消费）
  }

  // ── GameState.DebugPrintPower 数据段 ─────────────────────────────────────

  private handleData(data: string): void {
    /* v8 ignore next -- String.split 至少返回一个元素 */
    const opcode = data.split(/\s+/)[0] ?? ''

    if (opcode === 'ERROR:') return
    if (POWER_OPCODES.has(opcode)) {  this.handlePower(opcode, data); return }

    if (opcode === 'GameEntity') {
      this.flushChoices()
      this.flush()
      this.creatingGame = true
      const m = GAME_ENTITY_RE.exec(data)
      if (!m) throw new LineError(`bad GameEntity: ${data}`)
      /* v8 ignore next -- 对局由 CREATE_GAME 边界开启，readLine 到达时 game 恒已建立 */
      if (!this.game) throw new LineError('GameEntity before CREATE_GAME')
      if (this.game.id !== Number(m[1])) {
        throw new LineError(`GameEntity id mismatch: ${m[1]}`)
      }
      this.pending = { kind: 'game', game: this.game }
      return
    }

    if (opcode === 'Player') {
      this.flushChoices()
      this.flush()
      const m = PLAYER_ENTITY_RE.exec(data)
      if (!m) throw new LineError(`bad Player: ${data}`)
      const entityId = Number(m[1])
      const playerId = Number(m[2])
      const hi = Number(m[3])
      const lo = Number(m[4])
      const lazy = this.manager.createOrUpdatePlayer({
        entityId,
        playerId,
        isAi: lo === 0,
      })
      /* v8 ignore start -- Player 行显式携带实体 id，管理器引用必已解析 */
      if (lazy.entityId === null) {
        throw new LineError(`player ${playerId} has no entity id`)
      }
      /* v8 ignore stop */
      // FriendlyPlayerExporter.handle_player：AI/非 AI 归类
      if (lo === 0) this.aiPlayerId = playerId
      else this.nonAiPlayerIds.push(playerId)
      if (this.aiPlayerId !== null && this.nonAiPlayerIds.length === 1) {
        const firstNonAi = this.nonAiPlayerIds[0]
        /* v8 ignore next -- 列表长度已判 1，首元素必存在 */
        if (firstNonAi !== undefined) this.tryResolveFriendly(firstNonAi)
      }
      const player = new PlayerEntity(entityId, playerId, hi, lo)
      this.game?.registerEntity(player)
      this.pending = { kind: 'player', player }
      return
    }

    if (opcode.startsWith('tag=')) {
      const m = TAG_VALUE_RE.exec(data)
      if (!m) throw new LineError(`bad tag line: ${data}`)
      const [tag, value] = parseTag(capture(m, 1, 'tag line'), capture(m, 2, 'tag line'))
      if (!this.pending) throw new LineError('tag line before any entity')
      this.pendingTags.push([tag, value])
      if (tag === TAG.CONTROLLER && this.pending.kind !== 'game') {
        const entityId = pendingEntityId(this.pending)
        /* v8 ignore next -- pending 各形态的实体 id 恒非空 */
        if (entityId !== null) this.manager.registerController(entityId, value)
      }
      return
    }

    if (opcode.startsWith('Info[') || opcode === 'Source' || opcode.startsWith('Targets[')) {
      return // META_DATA / SubSpell 细节：实体树不消费
    }

    throw new LineError(`unhandled power data: ${data.slice(0, 60)}`)
  }

  // ── PowerType 操作码 ─────────────────────────────────────────────────────

  private handlePower(opcode: string, data: string): void {
    this.flushChoices()
    this.flush()

    if (opcode === 'CREATE_GAME') {
      if (data !== 'CREATE_GAME') throw new LineError('bad CREATE_GAME')
      this.beginGame()
      return
    }

    if (opcode === 'ACTION_START' || opcode === 'BLOCK_START') {
      this.handleBlockStart(opcode, data)
      return
    }

    if (opcode === 'ACTION_END' || opcode === 'BLOCK_END') {
      if (!BLOCK_END_RE.test(data)) throw new LineError(`bad ${opcode}`)
      if (this.blockDepth > 0) this.blockDepth -= 1
      return
    }

    if (opcode === 'FULL_ENTITY') {
      let entityId: number
      let cardId: string | null
      if (data.startsWith('FULL_ENTITY - Updating')) {
        const m = FULL_ENTITY_UPDATE_RE.exec(data)
        if (!m) throw new LineError(`bad FULL_ENTITY: ${data.slice(0, 60)}`)
        entityId = this.resolveEntityToken(capture(m, 1, 'FULL_ENTITY update'), 'game')
        cardId = m[2] ?? null
      } else {
        const m = FULL_ENTITY_CREATE_RE.exec(data)
        if (!m) throw new LineError(`bad FULL_ENTITY: ${data.slice(0, 60)}`)
        entityId = Number(m[1])
        cardId = m[2] ?? null
      }
      this.checkFirstFullEntity()
      const existing = this.game?.findEntityById(entityId)
      if (existing && existing !== this.game && existing instanceof CardEntity) {
        existing.cardId = cardId
        this.pending = { kind: 'full', card: existing }
        return
      }
      if (existing && existing !== this.game) {
        // Player 实体上 FULL_ENTITY：整局丢弃
        throw new GameExportError(`FULL_ENTITY on non-card entity ${entityId}`)
      }
      const card = new CardEntity(entityId, cardId, new Map())
      this.game?.registerEntity(card)
      this.pending = { kind: 'full', card }
      return
    }

    if (opcode === 'SHOW_ENTITY') {
      const m = SHOW_ENTITY_RE.exec(data)
      if (!m) throw new LineError(`bad SHOW_ENTITY: ${data.slice(0, 60)}`)
      const entityId = this.resolveEntityToken(capture(m, 1, 'SHOW_ENTITY'), 'game')
      const card = this.requireCard(entityId, 'SHOW_ENTITY')
      this.pending = { kind: 'show', card, cardId: capture(m, 2, 'SHOW_ENTITY') }
      return
    }

    if (opcode === 'HIDE_ENTITY') {
      const m = HIDE_ENTITY_RE.exec(data)
      if (!m) throw new LineError(`bad HIDE_ENTITY: ${data.slice(0, 60)}`)
      const entityId = this.resolveEntityToken(capture(m, 1, 'HIDE_ENTITY'), 'game')
      const [tag] = parseTag(capture(m, 2, 'HIDE_ENTITY'), capture(m, 3, 'HIDE_ENTITY'))
      if (tag !== TAG.ZONE) throw new LineError('HIDE_ENTITY non-zone tag')
      this.requireCard(entityId, 'HIDE_ENTITY').hide()
      return
    }

    if (opcode === 'CHANGE_ENTITY') {
      const m = CHANGE_ENTITY_RE.exec(data)
      if (!m) throw new LineError(`bad CHANGE_ENTITY: ${data.slice(0, 60)}`)
      const entityId = this.resolveEntityToken(capture(m, 1, 'CHANGE_ENTITY'), 'game')
      const card = this.requireCard(entityId, 'CHANGE_ENTITY')
      const changeCardId = capture(m, 2, 'CHANGE_ENTITY')
      card.change(changeCardId, new Map())
      this.pending = { kind: 'show', card, cardId: changeCardId }
      return
    }

    if (opcode === 'TAG_CHANGE') {
      this.handleTagChange(data)
      return
    }
    // META_DATA / RESET_GAME / SUB_SPELL_* / VO_SPELL / SHUFFLE_DECK /
    // CACHED_TAG_FOR_DORMANT_CHANGE：实体树不消费
  }

  private handleBlockStart(opcode: string, data: string): void {
    // 正则阶梯：SubOption 形态 → 常规形态 → 旧格式兜底
    let m: RegExpExecArray | null
    let typeIndex: number
    if (data.includes(' SubOption=')) {
      m = BLOCK_START_TRIGGER_RE.exec(data) ?? BLOCK_START_SUBOPTION_RE.exec(data)
      typeIndex = 1
    } else if (opcode === 'ACTION_START') {
      m = ACTION_START_RE.exec(data)
      typeIndex = 1
    } else {
      m = BLOCK_START_PLAIN_RE.exec(data)
      typeIndex = 1
    }
    if (!m) {
      m = ACTION_START_OLD_RE.exec(data)
      typeIndex = 2
    }
    if (!m) throw new LineError(`bad ${opcode}: ${data.slice(0, 60)}`)
    const typeToken = m[typeIndex]
    /* v8 ignore next -- 命中阶梯正则的必选捕获组 */
    if (typeToken === undefined) throw new LineError(`bad ${opcode}: missing block type`)
    const blockType = BLOCK_TYPE[typeToken]
    if (blockType === undefined) throw new LineError(`unknown BlockType ${typeToken}`)
    this.blockDepth += 1
    if (blockType === BLOCK_TYPE.GAME_RESET) this.game?.reset()
  }

  private handleTagChange(data: string): void {
    const m = TAG_CHANGE_RE.exec(data)
    if (!m) throw new LineError(`bad TAG_CHANGE: ${data.slice(0, 60)}`)
    const token = capture(m, 1, 'TAG_CHANGE')
    const [tag, value] = parseTag(capture(m, 2, 'TAG_CHANGE'), capture(m, 3, 'TAG_CHANGE'))

    if (token === '-1') {
      // entity=-1 无法落到具体实体：整局丢弃
      throw new GameExportError('TAG_CHANGE entity -1')
    }
    const id = this.parseEntityId(token)
    if (typeof id === 'number') {
      this.applyTagChange(id, tag, value)
      return
    }

    // 玩家名引用（parseEntityId 已注册/合并）
    const ref = id
    if (ref.entityId !== null) {
      this.applyTagChange(ref.entityId, tag, value)
      return
    }
    if (tag === GAME_TAG.ENTITY_ID) {
      // 解析路径：赋值触发回调 → 队列中更早的延迟包按序回放，再应用本条
      this.deferredTagChanges.push({ ref, tag, value })
      const resolved = this.manager.createOrUpdatePlayer({
        name: ref.name,
        entityId: value,
      })
      const entityId = resolved.entityId
      /* v8 ignore next -- 携带实体 id 的注册必然解析 */
      if (entityId !== null) this.applyTagChange(entityId, tag, value)
      return
    }
    if (tag === GAME_TAG.LAST_CARD_PLAYED) {
      const controller = this.manager.getControllerByEntityId(value)
      if (controller === undefined) {
        throw new LineError(`unknown entity on TAG_CHANGE: ${value}`)
      }
      // player_id 合并可能换到已有实体 id 的引用（包持有合并后的引用）
      const resolved = this.manager.createOrUpdatePlayer({
        name: ref.name,
        playerId: controller,
      })
      /* v8 ignore start -- 控制者玩家必然已由 Player 行解析出实体 id，false 臂不可达 */
      if (resolved.entityId !== null) {
        this.applyTagChange(resolved.entityId, tag, value)
      } else {
        this.deferredTagChanges.push({ ref: resolved, tag, value })
      }
      /* v8 ignore stop */
      return
    }
    this.deferredTagChanges.push({ ref, tag, value })
  }

  /** TAG_CHANGE 落地：找实体、设 tag、CONTROLLER 记账（管理器+友方推断双份）。 */
  private applyTagChange(entityId: number, tag: number, value: number): void {
    if (tag === TAG.CONTROLLER) {
      this.manager.registerController(entityId, value)
      this.controllerMap.set(entityId, value)
    }
    const target = this.game?.findEntityById(entityId)
    if (!target) {
      throw new GameExportError(`TAG_CHANGE on unknown entity ${entityId}`)
    }
    target.tags.set(tag, value)
  }

  /** 有引用获得实体 id：按队列顺序回放所有已可解析的延迟包。 */
  private flushResolvable(): void {
    for (let i = 0; i < this.deferredTagChanges.length; ) {
      const item = this.deferredTagChanges[i]
      /* v8 ignore next -- i 受数组长度约束，元素必存在 */
      if (item === undefined) break
      /* v8 ignore next 2 -- 回放时未解析项按序跳过；分支计数覆盖工具无法归因 */
      if (item.ref.entityId === null) {
        i += 1
        continue
      }
      this.deferredTagChanges.splice(i, 1)
      this.applyTagChange(item.ref.entityId, item.tag, item.value)
    }
  }

  // ── 实体令牌解析（tokens._E 的四个分支） ────────────────────────────────

  private parseEntityId(entity: string): number | PlayerReference {
    if (/^\d+$/.test(entity)) return Number(entity)
    /* v8 ignore next -- game 建立于 CREATE_GAME，此分支内必非空 */
    if (entity === GAME_ENTITY) return this.game?.id ?? 1
    const bracket = ENTITY_RE.exec(entity)
    if (bracket) return Number(bracket[1])
    return this.manager.createOrUpdatePlayer({ name: entity })
  }

  /**
   * SHOW/HIDE/CHANGE/FULL-Updating 的实体解析：名字令牌解析不出
   * → 整局丢弃。
   */
  private resolveEntityToken(token: string, _opcode: string): number {
    if (/^\d+$/.test(token)) return Number(token)
    if (token === GAME_ENTITY) {
      /* v8 ignore next -- game 建立于 CREATE_GAME，此分支内必非空 */
      return this.game?.id ?? 1
    }
    const bracket = ENTITY_RE.exec(token)
    if (bracket) return Number(bracket[1])
    throw new GameExportError(`entity unresolved for ${_opcode}: ${token}`)
  }

  private requireCard(id: number, opcode: string): CardEntity {
    const entity = this.game?.findEntityById(id)
    if (!entity || !(entity instanceof CardEntity)) {
      throw new GameExportError(`${opcode} on unknown entity ${id}`)
    }
    return entity
  }

  /** CREATE_GAME 后首个 FULL_ENTITY 前必须有 ≥2 玩家，否则跳行。 */
  private checkFirstFullEntity(): void {
    if (this.creatingGame) {
      this.creatingGame = false
      /* v8 ignore next -- creatingGame 为真时 game 必已建立（beginGame 先行） */
      if ((this.game?.players.length ?? 0) < 2) {
        throw new LineError('expected at least 2 players before the first entity')
      }
    }
  }

  private tryResolveFriendly(playerId: number): void {
    /* v8 ignore start -- game 建立于 CREATE_GAME；二次解析被调用点的一次性条件挡住 */
    if (this.friendlyResolved) return
    if (this.game !== null) this.game.friendlyPlayerByShow = playerId
    this.friendlyResolved = true
    /* v8 ignore stop */
  }

  // ── pending tag= 行的落地 ────────────────────────────────────────────────

  private flush(): void {
    const pending = this.pending
    if (!pending) return
    const tags = this.pendingTags
    this.pending = null
    this.pendingTags = []

    if (pending.kind === 'game') {
      pending.game.tags.clear()
      for (const [t, v] of tags) pending.game.tags.set(t, v)
    } else if (pending.kind === 'player') {
      pending.player.tags.clear()
      for (const [t, v] of tags) pending.player.tags.set(t, v)
    } else if (pending.kind === 'full') {
      pending.card.tags.clear()
      for (const [t, v] of tags) pending.card.tags.set(t, v)
      const controller = pending.card.tags.get(TAG.CONTROLLER)
      if (controller !== undefined) {
        this.controllerMap.set(pending.card.id, controller)
      }
    } else {
      // SHOW_ENTITY / CHANGE_ENTITY：揭示 + 合并； FriendlyPlayerExporter
      // 的 ZONE/CONTROLLER 判断用"包内 tags"（即本次累积的列表）
      pending.card.reveal(pending.cardId, new Map(tags))
      const controller = tags.find(([t]) => t === TAG.CONTROLLER)?.[1]
      if (controller !== undefined) {
        this.controllerMap.set(pending.card.id, controller)
      }
      const zone = tags.find(([t]) => t === TAG.ZONE)?.[1]
      if (zone === 3 /* Zone.HAND */ && !this.friendlyResolved) {
        // 首个手牌 SHOW_ENTITY 的控制者即友方；无控制者时保持
        // null，交给 detectFriendlyPlayerId 启发式兜底
        const friendly = this.controllerMap.get(pending.card.id)
        if (friendly !== undefined) this.tryResolveFriendly(friendly)
      }
    }
  }
}

function pendingEntityId(pending: NonNullable<Pending>): number | null {
  /* v8 ignore next -- 调用点排除 game 包形态 */
  if (pending.kind === 'game') return pending.game.id
  if (pending.kind === 'player') return pending.player.id
  return pending.card.id
}

/**
 * 解析 Power.log 行流（带或不带 [Power] 前缀），按 CREATE_GAME 边界切局。
 * @param rawLines - 原始日志行集合。
 * @returns 解析出的对局列表与坏行/丢局计数。
 */
export function parsePowerLog(rawLines: Iterable<string>): ParseResult {
  const games: GameEntityModel[] = []
  let skippedLines = 0
  let skippedGames = 0
  let current: GameParser | null = null
  const finished: GameParser[] = []

  for (const raw of rawLines) {
    const line = stripPowerPrefix(raw.replace(/\r?\n$/, ''))
    if (!line.trim()) continue

    if (isCreateGameLine(line)) {
      if (current) finished.push(current)
      current = new GameParser()
    }
    if (!current) continue

    try {
      current.readLine(line)
    } catch (error) {
      if (error instanceof GameExportError) {
        skippedGames += 1
        current = null
        continue
      }
      skippedLines += 1
    }
  }
  if (current) finished.push(current)

  for (const parser of finished) {
    if (!parser.game) continue // 只有 CREATE_GAME、无实体内容
    try {
      parser.finish()
    } catch (error) {
      /* v8 ignore start -- finish 只抛 GameExportError，重抛臂不可达 */
      if (error instanceof GameExportError) {
        skippedGames += 1
        continue
      }
      throw error
      /* v8 ignore stop */
    }
    games.push(parser.game)
  }
  return { games, skippedLines, skippedGames }
}
