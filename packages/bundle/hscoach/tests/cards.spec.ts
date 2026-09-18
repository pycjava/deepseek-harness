/**
 * 卡牌知识库单元测试：文本清洗、默认数据目录、构建/查询/迭代，
 * 以及可选收集卡文件的容错路径。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { CardDatabase, cleanText, defaultDataDirs } from '../src/core/cards.ts'

const DATA = join(import.meta.dirname, '..', 'data')

let extra: string | undefined

afterEach(async () => {
  if (extra !== undefined) {
    await rm(extra, { recursive: true, force: true })
    extra = undefined
  }
})

describe('cleanText', () => {
  it('清洗标记/占位/多余空行并修剪', () => {
    expect(cleanText('<b>嘲讽</b>')).toBe('嘲讽')
    expect(cleanText('造成{0}点伤害')).toBe('造成X点伤害')
    expect(cleanText('第一行\n\n\n\n第二行')).toBe('第一行\n\n第二行')
    expect(cleanText('  修剪  ')).toBe('修剪')
    expect(cleanText(null)).toBe('')
    expect(cleanText(undefined)).toBe('')
  })
})

describe('defaultDataDirs', () => {
  it('指向包内 data 目录', () => {
    expect(defaultDataDirs()).toEqual([DATA])
  })
})

describe('CardDatabase', () => {
  it('内置数据构建：get 命中与未命中、size 与 iterCards 一致、has', async () => {
    const db = new CardDatabase([DATA])
    await db.build()
    expect(db.size).toBeGreaterThan(1000)
    expect(db.size).toBe([...db.iterCards()].length)

    const fireball = db.get('CS2_029')
    expect(fireball?.name).toBeTruthy()
    expect(fireball?.cost).toBeGreaterThanOrEqual(0)
    expect(db.get('NOT_A_REAL_CARD')).toBeUndefined()

    // 重复 build 幂等
    const before = db.size
    await db.build()
    expect(db.size).toBe(before)
  })

  it('可选收集卡文件缺失可容忍（全卡文件必选）', async () => {
    const onlyAll = await mkdtemp(join(tmpdir(), 'hscoach-cards-allonly-'))
    extra = onlyAll
    await writeFile(
      join(onlyAll, 'cards.all.zhCN.json'),
      JSON.stringify([{ id: 'X_001', name: '全卡', cost: 1, type: 'MINION', cardClass: 'NEUTRAL', set: 'X' }]),
      'utf8',
    )
    const db = new CardDatabase([onlyAll])
    await db.build()
    expect(db.size).toBe(1)
    expect(db.get('X_001')?.name).toBe('全卡')
  })

  it('空目录（必选文件缺失）构建抛错', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'hscoach-cards-none-'))
    extra = empty
    const db = new CardDatabase([empty])
    await expect(db.build()).rejects.toThrow('cards.all.zhCN.json')
  })
})

describe('CardDatabase 补充分支', () => {
  it('has() 与损坏 JSON 目录回退', async () => {
    const db = new CardDatabase([DATA])
    await db.build()
    expect(db.has('CS2_029')).toBe(true)
    expect(db.has('NOT_A_REAL_CARD')).toBe(false)

    const corrupt = await mkdtemp(join(tmpdir(), 'hscoach-cards-corrupt-'))
    extra = corrupt
    await writeFile(join(corrupt, 'cards.all.zhCN.json'), '{corrupt', 'utf8')
    const mixed = new CardDatabase([corrupt, DATA])
    await mixed.build()
    expect(mixed.size).toBeGreaterThan(1000)
  })

  it('loadEntry 缺省字段回退（id 缺失跳过 / 名称回退 id / 零费）', async () => {
    const custom = await mkdtemp(join(tmpdir(), 'hscoach-cards-fields-'))
    extra = custom
    await writeFile(
      join(custom, 'cards.all.zhCN.json'),
      JSON.stringify([
        { id: 'A_1' },
        { id: 'A_2', name: '有名', text: '<b>粗体</b>', cost: 3, attack: 1, health: 2, type: 'MINION', cardClass: 'MAGE', set: 'TST' },
        { name: '无 id' },
      ]),
      'utf8',
    )
    const db = new CardDatabase([custom])
    await db.build()
    expect(db.size).toBe(2)
    expect(db.get('A_1')).toMatchObject({ name: 'A_1', cost: 0, attack: null, health: null, text: '', type: '', cardClass: '', cardSet: '' })
    expect(db.get('A_2')).toMatchObject({ name: '有名', text: '粗体', cost: 3, attack: 1, health: 2, type: 'MINION', cardClass: 'MAGE', cardSet: 'TST' })
    expect(db.has('A_2')).toBe(true)
  })
})
