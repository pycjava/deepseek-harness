/**
 * 对局结果检测与战绩统计单元测试：实体/昵称双路解析、非终局跳过、
 * 记录/聚合/原子写与时间格式。
 */
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  aggregate,
  atomicWriteJson,
  GameResultDetector,
  HISTORY_FILENAME,
  localIsoSeconds,
  recordResult,
} from '../src/core/history.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-history-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const power = (data: string) => `D 10:00:00.0000000 GameState.DebugPrintPower() - ${data}`

describe('GameResultDetector', () => {
  it('实体 id 路：Player EntityID 映射后按友方终局判定', () => {
    const detector = new GameResultDetector(1)
    expect(detector.feed([
      power('CREATE_GAME'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON'),
      power('TAG_CHANGE Entity=3 tag=PLAYSTATE value=LOST'),
    ])).toEqual(['win'])
    // 已触发后不再重复
    expect(detector.feed([power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON')])).toEqual([])
  })

  it('昵称路：PlayerName 映射与 PlayerOne/PlayerTwo 常量回退', () => {
    const named = new GameResultDetector(1)
    expect(named.feed([
      power('CREATE_GAME'),
      'D 10:00:00.0 GameState.DebugPrintPower() - PlayerID=1, PlayerName=玩家甲',
      power('TAG_CHANGE Entity=玩家甲 tag=PLAYSTATE value=WON'),
    ])).toEqual(['win'])

    const constant = new GameResultDetector(1)
    expect(constant.feed([
      power('CREATE_GAME'),
      power('TAG_CHANGE Entity=PlayerOne tag=PLAYSTATE value=TIED'),
    ])).toEqual(['tie'])

    const opponent = new GameResultDetector(2)
    expect(opponent.feed([
      power('CREATE_GAME'),
      power('TAG_CHANGE Entity=PlayerOne tag=PLAYSTATE value=LOST'),
      power('TAG_CHANGE Entity=PlayerTwo tag=PLAYSTATE value=WON'),
    ])).toEqual(['win'])
  })

  it('非终局值与未知令牌跳过；坏 PLAYSTATE 行忽略', () => {
    const detector = new GameResultDetector(1)
    expect(detector.feed([
      power('CREATE_GAME'),
      power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=PLAYING'),
      power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WINNING'),
      power('TAG_CHANGE Entity=查无此人 tag=PLAYSTATE value=WON'),
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=2 tag=PLAYSTATE value=',
    ])).toEqual([])
  })

  it('reset 清空已触发标记', () => {
    const detector = new GameResultDetector(1)
    detector.feed([power('CREATE_GAME'), power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON')])
    detector.reset()
    expect(detector.feed([power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON')])).toEqual(['win'])
  })

  it('国服重复 CREATE_GAME 行不是边界', () => {
    const detector = new GameResultDetector(1)
    detector.feed([
      power('CREATE_GAME'),
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON'),
    ])
    // PowerTaskList 频道的重复行不清映射
    expect(detector.feed([
      'D 10:00:00.0 PowerTaskList.DebugPrintPower() - CREATE_GAME',
      power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=LOST'),
    ])).toEqual([])
  })
})

describe('recordResult / aggregate / atomicWriteJson', () => {
  it('空职业回退未知；追加并聚合战绩', async () => {
    const first = await recordResult(dir, 'win', '', '', 12)
    expect(first).toEqual({ total: 1, wins: 1, losses: 0, ties: 0, winrate_pct: 100 })
    const historyText = await readFile(join(dir, HISTORY_FILENAME), 'utf8')
    const history = historyText.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l) as {
      friendly_class?: string
      opponent_class?: string
      result?: string
    })
    expect(history[0]?.friendly_class).toBe('未知')
    expect(history[0]?.opponent_class).toBe('未知')

    await recordResult(dir, 'loss', 'MAGE', 'HUNTER', 8)
    await recordResult(dir, 'tie', 'MAGE', 'HUNTER', 10)
    const stats = await aggregate(join(dir, HISTORY_FILENAME))
    expect(stats).toEqual({ total: 3, wins: 1, losses: 1, ties: 1, winrate_pct: 33.3 })
  })

  it('aggregate 容忍缺失与损坏行', async () => {
    const missing = await aggregate(join(dir, 'nope.jsonl'))
    expect(missing.total).toBe(0)

    await writeFile(join(dir, HISTORY_FILENAME), '{corrupt\n\n{"result":"win"}\n', 'utf8')
    const stats = await aggregate(join(dir, HISTORY_FILENAME))
    expect(stats.total).toBe(1)
    expect(stats.wins).toBe(1)
  })

  it('atomicWriteJson 原子替换既有文件', async () => {
    const target = join(dir, 'x.json')
    await atomicWriteJson(target, { a: 1 })
    await atomicWriteJson(target, { b: 2 })
    const content = JSON.parse(await readFile(target, 'utf8')) as { a?: number; b?: number }
    expect(content).toEqual({ b: 2 })
    expect(existsSync(target)).toBe(true)
  })
})

describe('localIsoSeconds', () => {
  it('本地时间秒精度格式', () => {
    const text = localIsoSeconds(new Date(2026, 8, 17, 9, 5, 3))
    expect(text).toBe('2026-09-17T09:05:03')
  })
})

describe('GameResultDetector/聚合收尾', () => {
  it('正则失配的映射行静默忽略', () => {
    const detector = new GameResultDetector(1)
    expect(detector.feed([
      power('CREATE_GAME'),
      'D 10:00:00.0 x Player EntityID=bad PlayerID=zz',
      'D 10:00:00.0 x PlayerID=bad, PlayerName=',
      power('TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON'),
    ])).toEqual(['win'])
  })

  it('history 文件是目录时聚合返回空战绩', async () => {
    const { mkdir } = await import('node:fs/promises')
    const path = join(dir, HISTORY_FILENAME)
    await mkdir(path, { recursive: true })
    const stats = await aggregate(path)
    expect(stats.total).toBe(0)
  })

  it('空文件聚合 total 为 0，不计算胜率', async () => {
    await writeFile(join(dir, HISTORY_FILENAME), '\n \n', 'utf8')
    const stats = await aggregate(join(dir, HISTORY_FILENAME))
    expect(stats).toEqual({ total: 0, wins: 0, losses: 0, ties: 0, winrate_pct: 0 })
  })
})
