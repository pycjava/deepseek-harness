/**
 * tag 解析。
 *
 * 语义（黄金快照硬约束）：
 * - 未知 tag 名 → 抛错（调用方按"跳过该行"处理，两侧一致）
 * - TAG_TYPES 命中值枚举（Zone/CardType/...）→ 十进制或枚举名
 * - TAG_TYPES 命中 Type.* 标量类型 → 仅十进制
 * - 未命中 TAG_TYPES → 仅十进制
 */
import { GAME_TAG, TAG_TYPES, VALUE_ENUMS } from './enums.generated.ts'

/**
 * 解析单个 GameTag 常量；缺失即抛错。生成表是冻结数据，缺失名只可能
 * 是生成器缺陷（fail loud 优于静默 NaN）。
 * @param name - GameTag 枚举名。
 * @returns 对应的 tag 数值。
 */
function gameTag(name: string): number {
  const value = GAME_TAG[name]
  /* v8 ignore next -- 生成表是冻结数据，常量表内的名字必存在；缺失即生成器缺陷 */
  if (value === undefined) throw new Error(`unknown GameTag ${name}`)
  return value
}

/** 教练直接消费的 tag 常量（值来自生成表，避免魔法数字散落）。 */
export const TAG = {
  TURN: gameTag('TURN'),
  CURRENT_PLAYER: gameTag('CURRENT_PLAYER'),
  CONTROLLER: gameTag('CONTROLLER'),
  HERO_ENTITY: gameTag('HERO_ENTITY'),
  HEALTH: gameTag('HEALTH'),
  ATK: gameTag('ATK'),
  DAMAGE: gameTag('DAMAGE'),
  COST: gameTag('COST'),
  ARMOR: gameTag('ARMOR'),
  RESOURCES: gameTag('RESOURCES'),
  MAXRESOURCES: gameTag('MAXRESOURCES'),
  FATIGUE: gameTag('FATIGUE'),
  CARDTYPE: gameTag('CARDTYPE'),
  ZONE: gameTag('ZONE'),
  ENTITY_ID: gameTag('ENTITY_ID'),
  ZONE_POSITION: gameTag('ZONE_POSITION'),
} as const

/** CardType 枚举的 HERO 值。 */
export const CARDTYPE_HERO = 2
/** 教练消费的 Zone 枚举值子集。 */
export const ZONE = {
  INVALID: 0,
  PLAY: 1,
  DECK: 2,
  HAND: 3,
  GRAVEYARD: 4,
  SECRET: 7,
} as const

const DECIMAL_RE = /^\d+$/

/**
 * tag/value 双段解析；任何无法识别的组合都抛 ParseTagError。
 * @param tagName - tag 名（或十进制数字 tag）。
 * @param value - tag 值（十进制或枚举名）。
 * @returns 解析出的 [tag, value] 数值对。
 */
export function parseTag(tagName: string, value: string): [number, number] {
  // 十进制直接转 int（真实日志存在数字 tag 名，如 tag=479）
  const tag = DECIMAL_RE.test(tagName) ? Number(tagName) : GAME_TAG[tagName]
  if (tag === undefined) throw new ParseTagError(`unknown GameTag ${tagName}`)
  const enumName = TAG_TYPES[tag]
  if (enumName !== undefined && !enumName.startsWith('Type.')) {
    const table = VALUE_ENUMS[enumName]
    if (DECIMAL_RE.test(value)) return [tag, Number(value)]
    const byName = table?.[value]
    if (byName !== undefined) return [tag, byName]
    throw new ParseTagError(`unknown ${enumName} value ${value}`)
  }
  // Type.* 标量（BOOL/LOCSTRING/...）与无类型 tag：仅十进制
  if (DECIMAL_RE.test(value)) return [tag, Number(value)]
  throw new ParseTagError(`invalid value ${tagName}=${value}`)
}

/** tag 解析失败（未知 tag 名/值）；调用方按"跳过该行"处理。 */
export class ParseTagError extends Error {}
