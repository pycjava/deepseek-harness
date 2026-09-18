/**
 * 回合触发与发布单元测试：isNewFriendlyTurn、增量检测器
（预过滤开/关、昵称令牌、窗口截取、reset）与原子发布契约。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  emptyAdvice,
  GAME_STATE_FILENAME,
  IncrementalTurnDetector,
  isNewFriendlyTurn,
  publishAdvice,
  publishGameState,
} from '../src/core/trigger.ts'
import type { GameSnapshot } from '../src/core/state.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-trigger-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const power = (data: string) => `D 10:00:00.0000000 GameState.DebugPrintPower() - ${data}`

describe('isNewFriendlyTurn', () => {
  it('当前玩家是友方且回合递增才算新回合', () => {
    expect(isNewFriendlyTurn(3, 1, 1, 2)).toBe(true)
    expect(isNewFriendlyTurn(3, 2, 1, 2)).toBe(false)
    expect(isNewFriendlyTurn(3, null, 1, 2)).toBe(false)
    expect(isNewFriendlyTurn(2, 1, 1, 2)).toBe(false)
    expect(isNewFriendlyTurn(1, 1, 1, 0)).toBe(true)
  })
})

describe('IncrementalTurnDetector', () => {
  it('TURN 递增触发；重复回合号不触发', () => {
    const detector = new IncrementalTurnDetector(1, false)
    expect(detector.feed([power('TAG_CHANGE Entity=2 tag=TURN value=1')])).toEqual([1])
    expect(detector.feed([power('TAG_CHANGE Entity=2 tag=TURN value=1')])).toEqual([])
    expect(detector.feed([power('TAG_CHANGE Entity=2 tag=TURN value=2')])).toEqual([2])
  })

  it('预过滤开启时仅触发友方回合；关闭时触发全部', () => {
    const lines = [
      power('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=2 tag=CURRENT_PLAYER value=1',
      power('TAG_CHANGE Entity=2 tag=TURN value=1'),
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=3 tag=CURRENT_PLAYER value=1',
      power('TAG_CHANGE Entity=3 tag=TURN value=2'),
    ]
    const prefiltered = new IncrementalTurnDetector(1, true)
    expect(prefiltered.feed(lines)).toEqual([1])

    const all = new IncrementalTurnDetector(1, false)
    expect(all.feed(lines)).toEqual([1, 2])
  })

  it('PlayerOne/PlayerTwo 昵称令牌与未知令牌', () => {
    const detector = new IncrementalTurnDetector(1, false)
    detector.feed([
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=PlayerOne tag=CURRENT_PLAYER value=1',
      power('TAG_CHANGE Entity=2 tag=TURN value=1'),
    ])
    expect(detector.feed([
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=PlayerTwo tag=CURRENT_PLAYER value=1',
      power('TAG_CHANGE Entity=3 tag=TURN value=2'),
    ])).toEqual([2])

    const unknown = new IncrementalTurnDetector(1, false)
    unknown.feed([
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=别的家伙 tag=CURRENT_PLAYER value=1',
      power('TAG_CHANGE Entity=2 tag=TURN value=1'),
    ])
    expect(unknown.getAllLines().length).toBe(2)

    // 非 1 值的 CURRENT_PLAYER 行被忽略
    const zero = new IncrementalTurnDetector(1, false)
    zero.feed(['D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=PlayerOne tag=CURRENT_PLAYER value=0'])
    expect(zero.feed([power('TAG_CHANGE Entity=2 tag=TURN value=1')])).toEqual([1])
  })

  it('触发窗口截取与 reset', () => {
    const detector = new IncrementalTurnDetector(1, false)
    detector.feed([
      power('TAG_CHANGE Entity=2 tag=TURN value=1'),
      power('TAG_CHANGE Entity=2 tag=TURN value=2'),
    ])
    const window = detector.getTriggerWindow(1)
    expect(window.length).toBe(1)
    expect(detector.getTriggerWindow(99).length).toBe(2)
    detector.reset()
    expect(detector.getAllLines()).toEqual([])
    expect(detector.getTriggerWindow(1)).toEqual([])
  })

  it('CREATE_GAME 行清空实体映射', () => {
    const detector = new IncrementalTurnDetector(1, false)
    detector.feed([
      'D 10:00:00.0 GameState.DebugPrintPower() - CREATE_GAME',
      power('Player EntityID=4 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
    ])
    // 新局实体 2/3 未注册：PlayerOne 回退 eid-1 = 1
    const triggered = detector.feed([
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=PlayerOne tag=CURRENT_PLAYER value=1',
      power('TAG_CHANGE Entity=5 tag=TURN value=3'),
    ])
    expect(triggered).toEqual([3])
  })
})

describe('发布契约', () => {
  it('emptyAdvice 全空字段；publishAdvice/publishGameState 原子写文件', async () => {
    const advice = emptyAdvice()
    expect(advice.kind).toBe('uncertain')
    expect(advice.steps).toEqual([])
    expect(advice.alternatives).toEqual([])
    expect(advice.degraded).toBe(false)

    const path = await publishAdvice(dir, advice, 5)
    expect(path).toBe(join(dir, 'advice.json'))
    const written = JSON.parse(await readFile(path, 'utf-8')) as { turn?: number; advice?: unknown }
    expect(written.turn).toBe(5)
    expect(written.advice).toEqual(advice)

    const snapshot: GameSnapshot = {
      turn: 5,
      currentPlayerId: 1,
      players: {
        1: {
          name: '我',
          hero: null,
          health: 30,
          armor: 0,
          mana: 3,
          maxMana: 3,
          hand: [],
          board: [],
          deckCount: 20,
          fatigue: 0,
          playedCards: [],
          secrets: 0,
          possibleSecrets: [],
        },
      },
    }
    const statePath = await publishGameState(dir, snapshot, 1)
    expect(statePath).toBe(join(dir, GAME_STATE_FILENAME))
    const state = JSON.parse(await readFile(statePath, 'utf-8')) as {
      friendly_player_id?: number
      players?: Record<string, { draw_odds?: unknown; deck_count?: number }>
    }
    expect(state.friendly_player_id).toBe(1)
    expect(state.players?.['1']?.draw_odds).toBeDefined()
    expect(existsSync(statePath)).toBe(true)

    // 空牌库不注入 draw_odds
    const emptied = { ...snapshot.players['1']!, deckCount: 0 }
    const empty = await publishGameState(dir, { ...snapshot, players: { 1: emptied } }, 1)
    const emptyState = JSON.parse(await readFile(empty, 'utf-8')) as {
      players?: Record<string, { draw_odds?: unknown }>
    }
    expect(emptyState.players?.['1']?.draw_odds).toBeUndefined()
  })
})

describe('检测器正则失配分支', () => {
  it('TURN/CURRENT_PLAYER 行格式不符时静默忽略', () => {
    const detector = new IncrementalTurnDetector(1, false)
    expect(detector.feed([
      'D 10:00:00.0 x tag=TURN value=',
      'D 10:00:00.0 x tag=CURRENT_PLAYER value=1',
      'D 10:00:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=别的家伙 tag=CURRENT_PLAYER value=1',
    ])).toEqual([])
    expect(detector.getAllLines().length).toBe(3)
  })
})
