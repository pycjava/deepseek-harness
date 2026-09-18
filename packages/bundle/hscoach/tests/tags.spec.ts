/**
 * tag 解析单元测试：数字 tag 名、Type.* 标量、无类型 tag 与全部错误路径。
 */
import { describe, expect, it } from 'vitest'
import { GAME_TAG, TAG_TYPES } from '../src/core/enums.generated.ts'
import { parseTag, ParseTagError, TAG } from '../src/core/tags.ts'

describe('parseTag', () => {
  it('数字 tag 名直接转 int', () => {
    expect(parseTag('479', '1')).toEqual([479, 1])
  })

  it('枚举类型 tag：十进制或枚举名', () => {
    expect(parseTag('ZONE', '2')).toEqual([TAG.ZONE, 2])
    expect(parseTag('ZONE', 'DECK')).toEqual([TAG.ZONE, 2])
  })

  it('Type.* 标量与无类型 tag 仅接受十进制', () => {
    const scalarValue = Object.entries(TAG_TYPES).find(([, tKind]) => tKind.startsWith('Type.'))?.[0]
    expect(scalarValue).toBeDefined()
    if (scalarValue !== undefined) {
      // TAG_TYPES 的键是 tag 数值；数字 tag 名走十进制直转路径
      expect(parseTag(scalarValue, '1')).toEqual([Number(scalarValue), 1])
      const scalarName = Object.entries(GAME_TAG).find(([, value]) => String(value) === scalarValue)?.[0]
      expect(scalarName).toBeDefined()
      if (scalarName !== undefined) {
        expect(() => parseTag(scalarName, 'true')).toThrow(ParseTagError)
      }
    }
    const untypedName = Object.entries(GAME_TAG).find(([, value]) => TAG_TYPES[value] === undefined)?.[0]
    expect(untypedName).toBeDefined()
    if (untypedName !== undefined) {
      expect(parseTag(untypedName, '7')).toEqual([GAME_TAG[untypedName]!, 7])
      expect(() => parseTag(untypedName, 'abc')).toThrow(ParseTagError)
    }
  })

  it('未知 GameTag 与未知枚举值抛错', () => {
    expect(() => parseTag('NOT_A_TAG', '1')).toThrow(ParseTagError)
    expect(() => parseTag('ZONE', 'NOWHERE')).toThrow(ParseTagError)
  })
})
