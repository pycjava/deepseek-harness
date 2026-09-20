/**
 * 复盘基础模块测试：切批、琐碎判定、缓存键与读写、赛后总结 prompt/生成、
 * 历史日志扫描。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planReplay } from '../src/replay/splitter.ts'
import {
  fastForwardAdvice,
  hasAvailableAction,
  isTrivialTurn,
  trivialAdvice,
} from '../src/replay/trivial.ts'
import { AdviceCache, adviceCacheKey, stableStringify } from '../src/replay/cache.ts'
import { buildReviewPrompt, ReviewGenerator } from '../src/replay/review.ts'
import { ProviderError } from '../src/advice/directProvider.ts'
import { scanLogSessions, scanPowerLog } from '../src/core/logScan.ts'
import type { GameSnapshot, PlayerView } from '../src/core/state.ts'
import type { Advice } from '../src/core/trigger.ts'

const CREATE_GAME = 'D 22:26:34.1 GameState.DebugPrintPower() - CREATE_GAME'
const turnLine = (n: number): string =>
  `D 22:26:35.1 GameState.DebugPrintPower() - TAG_CHANGE Entity=GameEntity tag=TURN value=${n}`
const turnEcho = (n: number): string =>
  `D 22:26:35.2 PowerTaskList.DebugPrintPower() -     TAG_CHANGE Entity=GameEntity tag=TURN value=${n}`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-replay-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('planReplay 切批', () => {
  it('按 CREATE_GAME 切局、按 TURN 递增切回合（重复行不额外切批）', () => {
    const lines = [
      CREATE_GAME,
      turnLine(1), turnEcho(1),
      turnLine(2), turnEcho(2),
      'D 22:27:00.0 GameState.DebugPrintPower() - TAG_CHANGE Entity=GameEntity tag=TURN value=2',
      CREATE_GAME,
      turnLine(1),
      turnLine(2),
      turnLine(3),
    ]
    const plans = planReplay(lines)
    expect(plans).toHaveLength(2)
    expect(plans[0]?.index).toBe(0)
    // 局1：准备阶段(0) + T1 + T2（重复与倒退的 TURN 行并入当前批）
    expect(plans[0]?.segments.map(s => s.turn)).toEqual([0, 1, 2])
    expect(plans[0]?.segments[2]?.lines).toHaveLength(3)
    expect(plans[1]?.segments.map(s => s.turn)).toEqual([0, 1, 2, 3])
    expect(plans[1]?.segmentCount).toBe(4)
  })

  it('没有 CREATE_GAME 的日志整体当作一局（准备阶段从第 0 行起）', () => {
    const plans = planReplay(['D 1 noop', turnLine(1), 'D 2 x'])
    expect(plans).toHaveLength(1)
    expect(plans[0]?.segments.map(s => s.turn)).toEqual([0, 1])
    expect(plans[0]?.segments[0]?.lines).toEqual(['D 1 noop'])
  })
})

/** 构造最小可用快照（只填琐碎判定读到的字段）。 */
function snapshot(overrides: {
  mana?: number
  hand?: unknown
  board?: Array<Partial<PlayerView['board'][number]>>
  players?: Record<string, unknown>
}): GameSnapshot {
  const view = {
    name: '我方',
    hero: null,
    health: 30,
    armor: 0,
    mana: overrides.mana ?? 3,
    maxMana: 3,
    hand: overrides.hand ?? [],
    board: overrides.board ?? [],
    deckCount: 20,
    fatigue: 0,
    playedCards: [],
    secrets: 0,
    possibleSecrets: [],
  }
  return {
    turn: 3,
    currentPlayerId: 1,
    players: (overrides.players ?? { '1': view }) as GameSnapshot['players'],
  }
}

const card = (over: Partial<PlayerView['board'][number]>): PlayerView['board'][number] => ({
  cardId: null,
  name: '卡',
  cost: null,
  attack: null,
  health: null,
  flags: [],
  text: '',
  damaged: null,
  cardType: 'MINION',
  cardClass: null,
  ...over,
})

describe('琐碎回合判定（保守规则）', () => {
  it('斩杀可用 → 有动作', () => {
    const lethal = { lethal: true } as Parameters<typeof hasAvailableAction>[2]
    expect(hasAvailableAction(snapshot({}), 1, lethal)).toBe(true)
  })

  it('有可出的手牌 → 有动作', () => {
    expect(hasAvailableAction(snapshot({ mana: 3, hand: [card({ cost: 2 })] }), 1, null)).toBe(true)
  })

  it('成本未知的手牌按可出处理（保守）', () => {
    expect(hasAvailableAction(snapshot({ mana: 3, hand: [card({ cost: null })] }), 1, null)).toBe(true)
  })

  it('有可攻击随从 → 有动作；已尽/冻结随从不算', () => {
    expect(
      hasAvailableAction(snapshot({ board: [card({ attack: 2, flags: [] })] }), 1, null),
    ).toBe(true)
    expect(
      hasAvailableAction(snapshot({ board: [card({ attack: 2, flags: ['已尽'] })] }), 1, null),
    ).toBe(false)
    expect(
      hasAvailableAction(snapshot({ board: [card({ attack: 2, flags: ['冻结'] })] }), 1, null),
    ).toBe(false)
    expect(hasAvailableAction(snapshot({ board: [card({ attack: 0 })] }), 1, null)).toBe(false)
  })

  it('英雄技能可用 → 有动作；已尽或法力不足不算', () => {
    const power = (flags: string[], cost: number): PlayerView['board'][number] =>
      card({ cardType: 'HERO_POWER', cost, flags })
    expect(hasAvailableAction(snapshot({ mana: 3, board: [power([], 2)] }), 1, null)).toBe(true)
    expect(hasAvailableAction(snapshot({ mana: 3, board: [power(['已尽'], 2)] }), 1, null)).toBe(false)
    expect(hasAvailableAction(snapshot({ mana: 1, board: [power([], 2)] }), 1, null)).toBe(false)
  })

  it('手牌不可见（对手视角）或友方缺席 → 判不准，按有动作处理', () => {
    expect(hasAvailableAction(snapshot({ hand: { count: 3 } }), 1, null)).toBe(true)
    expect(hasAvailableAction(snapshot({ players: {} }), 1, null)).toBe(true)
  })

  it('确实无动作 → 琐碎；规则建议满足契约', () => {
    const snap = snapshot({ mana: 1, hand: [card({ cost: 5 })], board: [card({ attack: 3, flags: ['已尽'] })] })
    expect(isTrivialTurn(snap, 1, null)).toBe(true)
    const advice = trivialAdvice(5)
    expect(advice.kind).toBe('pass')
    expect(advice.degraded).toBe(false)
    expect(advice.steps).toEqual(['结束回合'])
    expect(advice.why).toContain('第 5 回合')
  })

  it('快进占位建议满足契约', () => {
    const advice = fastForwardAdvice(7)
    expect(advice.headline).toContain('第 7 回合')
    expect(advice.kind).toBe('uncertain')
    expect(advice.lethal).toBe(false)
  })
})

describe('建议缓存', () => {
  const snap = (turn: number): GameSnapshot => ({ ...snapshot({}), turn })
  const advice: Advice = {
    kind: 'play', headline: 'h', why: 'w', steps: [], warning: '', alternatives: [],
    latency_ms: 3, degraded: false, lethal: false,
  }

  it('稳定序列化：键序不影响结果', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }),
    )
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify('x')).toBe('"x"')
  })

  it('缓存键随模型、模式、局面变化', () => {
    const base = adviceCacheKey({ model: 'm1', coachMode: 'teach', snapshot: snap(3) })
    expect(base).toBe(adviceCacheKey({ model: 'm1', coachMode: 'teach', snapshot: snap(3) }))
    expect(base).not.toBe(adviceCacheKey({ model: 'm2', coachMode: 'teach', snapshot: snap(3) }))
    expect(base).not.toBe(adviceCacheKey({ model: 'm1', coachMode: 'compete', snapshot: snap(3) }))
    const other: GameSnapshot = { ...snap(3), turn: 4 }
    expect(base).not.toBe(adviceCacheKey({ model: 'm1', coachMode: 'teach', snapshot: other }))
  })

  it('读写往返、未命中、损坏文件按未命中处理，计数器正确', async () => {
    const cache = new AdviceCache(join(dir, 'cache'))
    expect(await cache.get('missing')).toBeNull()
    expect(cache.missCount).toBe(1)
    await cache.put('k1', { model: 'm', coachMode: 'teach', turn: 3 }, advice)
    expect(await cache.get('k1')).toEqual(advice)
    expect(cache.hitCount).toBe(1)

    await writeFile(join(dir, 'cache', 'broken.json'), '{ not json', 'utf-8')
    expect(await cache.get('broken')).toBeNull()
    // 结构不合法（缺 advice.headline）同样按未命中
    await writeFile(join(dir, 'cache', 'shape.json'), JSON.stringify({ advice: {} }), 'utf-8')
    expect(await cache.get('shape')).toBeNull()
    expect(cache.missCount).toBe(3)
  })
})

describe('赛后总结', () => {
  const input = {
    gameIndex: 0,
    totalTurns: 14,
    result: 'win',
    friendlyName: '我方',
    opponentName: '对手',
    friendlyClass: 'MAGE',
    opponentClass: 'SHAMAN',
    coachMode: 'teach',
    model: 'mock',
    turns: [
      { turn: 2, kind: 'play', headline: '铺场', why: '抢节奏', steps: ['下怪'], warning: '', source: 'llm' },
      { turn: 4, kind: 'pass', headline: '无动作', why: '', steps: [], warning: '', source: 'rule' },
    ],
  }

  it('prompt 含三节结构、逐回合建议与规则标注', () => {
    const { system, user } = buildReviewPrompt(input)
    expect(system).toContain('## 关键回合')
    expect(user).toContain('第 2 回合 [play] 铺场')
    expect(user).toContain('规则判定')
    expect(user).toContain('MAGE')
  })

  it('无建议时 prompt 明确说明（全程快进）', () => {
    const { user } = buildReviewPrompt({ ...input, turns: [] })
    expect(user).toContain('没有生成任何建议')
  })

  it('无 API key 抛 ProviderError', async () => {
    const gen = new ReviewGenerator({ baseURL: 'http://x', apiKey: '', model: 'm' })
    await expect(gen.generate(input)).rejects.toBeInstanceOf(ProviderError)
  })

  it('成功生成并落盘', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const gen = new ReviewGenerator({
      baseURL: 'http://mock/v1/',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async (url: string, init?: RequestInit) => {
        const rawBody = typeof init?.body === 'string' ? init.body : 'null'
        calls.push({ url, body: JSON.parse(rawBody) as unknown })
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: '  # 复盘\n关键回合…  ' } }] }),
        }
      },
    })
    const path = join(dir, 'game', 'review.md')
    const text = await gen.generateToFile(input, path)
    expect(text).toBe('# 复盘\n关键回合…')
    expect(await readFile(path, 'utf-8')).toBe('# 复盘\n关键回合…\n')
    expect(calls[0]?.url).toBe('http://mock/v1/chat/completions')
    // 赛后总结是自由文本调用：不带 JSON 契约，但带上限与流式开关
    expect(calls[0]?.body).toMatchObject({ model: 'm', max_tokens: 8192, stream: false })
  })

  it('推理截断（finish_reason=length）→ 2 倍预算重试后成功', async () => {
    const calls: Array<{ max_tokens?: number }> = []
    const responses = [
      { choices: [{ finish_reason: 'length', message: { content: '' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: '# 复盘\n关键回合…' } }] },
    ]
    const gen = new ReviewGenerator({
      baseURL: 'http://mock',
      apiKey: 'k',
      model: 'm',
      fetchImpl: async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as { max_tokens?: number })
        return {
          ok: true,
          status: 200,
          json: async () => responses.shift(),
        }
      },
    })
    await expect(gen.generate(input)).resolves.toContain('# 复盘')
    expect(calls.map(c => c.max_tokens)).toEqual([8192, 16_384])
  })

  it('非 200、内容缺失、请求异常都抛 ProviderError', async () => {
    const gen = (impl: unknown): ReviewGenerator =>
      new ReviewGenerator({
        baseURL: 'http://mock',
        apiKey: 'k',
        model: 'm',
        fetchImpl: impl as typeof fetch,
      })
    await expect(
      gen(async () => ({ ok: false, status: 500, statusText: 'boom' })).generate(input),
    ).rejects.toThrow(/500/)
    await expect(
      gen(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })).generate(input),
    ).rejects.toThrow(/缺少 choices/)
    await expect(
      gen(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '   ' } }] }) })).generate(input),
    ).rejects.toThrow(/缺少 choices/)
    await expect(
      gen(async () => {
        throw new Error('network down')
      }).generate(input),
    ).rejects.toThrow(/请求失败/)
  })

  it('超时（abort）抛超时错误', async () => {
    const gen = new ReviewGenerator({
      baseURL: 'http://mock',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 5,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        })) as unknown as typeof fetch,
    })
    await expect(gen.generate(input)).rejects.toThrow(/超时/)
  })
})

describe('历史日志扫描', () => {
  const fixture = readFileSync(
    join(import.meta.dirname, 'fixtures', 'friendly_player_id_is_1.power.log'),
    'utf-8',
  )

  it('无对局时按空列表处理（缺目录 / 无 Power.log）', async () => {
    const logsRoot = join(dir, 'Logs-empty')
    await mkdir(join(logsRoot, 'Hearthstone_2026_08_16_22_21_22'), { recursive: true })
    expect(await scanLogSessions(logsRoot)).toEqual([])
  })

  it('扫描会话目录：读会话时间戳、对局摘要与胜负', async () => {
    const logsRoot = join(dir, 'Logs')
    await mkdir(join(logsRoot, 'Hearthstone_2026_08_16_22_21_22'), { recursive: true })
    await mkdir(join(logsRoot, 'Hearthstone_2026_08_16_23_45_33'), { recursive: true })
    await writeFile(
      join(logsRoot, 'Hearthstone_2026_08_16_22_21_22', 'Power.log'),
      fixture,
      'utf-8',
    )
    const sessions = await scanLogSessions(logsRoot)
    expect(sessions).toHaveLength(1)
    const session = sessions[0]
    expect(session?.sessionStamp).toBe('2026_08_16_22_21_22')
    expect(session?.games).toHaveLength(1)
    const game = session?.games[0]
    expect(game?.gameIndex).toBe(0)
    expect(game?.turns).toBeGreaterThan(0)
    expect(game?.friendlyClass).toBe('PRIEST')
    // fixture：友方（后手）落败，名字取自日志的 PlayerName 注册行
    expect(game?.result).toBe('loss')
    expect(game?.friendlyName.length).toBeGreaterThan(0)
    expect(game?.startedAt).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('目录不存在 → 空列表；无对局的日志 → games 为空', async () => {
    expect(await scanLogSessions(join(dir, 'nope'))).toEqual([])
    const emptyDir = join(dir, 'empty-session')
    await mkdir(emptyDir, { recursive: true })
    const logPath = join(emptyDir, 'Power.log')
    await writeFile(logPath, 'D 1 nothing here\n', 'utf-8')
    const scanned = await scanPowerLog(logPath, emptyDir, 18, '2026-09-19T00:00:00')
    expect(scanned.games).toEqual([])
    expect(scanned.sessionStamp).toBeNull()
  })

  it('有对局但拿不到时长时间戳时，startedAt 为 null', async () => {
    const logPath = join(dir, 'Power.log')
    // 刻意不带 `D HH:MM:SS` 前缀：时间戳取不到时保持 null，不编造
    await writeFile(
      logPath,
      [
        'GameState.DebugPrintPower() - CREATE_GAME',
        'GameState.DebugPrintPower() - TAG_CHANGE Entity=GameEntity tag=TURN value=1',
      ].join('\n'),
      'utf-8',
    )
    const scanned = await scanPowerLog(logPath, join(dir, 'x'), 10, '2026-09-19T00:00:00')
    expect(scanned.games).toHaveLength(1)
    expect(scanned.games[0]?.startedAt).toBeNull()
  })

  it('scanLogSessions 覆盖有日志的多个会话并按时间戳排序', async () => {
    const logsRoot = join(dir, 'Logs2')
    for (const stamp of ['2026_08_16_22_21_22', '2026_09_12_17_46_29']) {
      await mkdir(join(logsRoot, `Hearthstone_${stamp}`), { recursive: true })
      await writeFile(
        join(logsRoot, `Hearthstone_${stamp}`, 'Power.log'),
        `${CREATE_GAME}\n${turnLine(1)}\n`,
        'utf-8',
      )
    }
    const sessions = await scanLogSessions(logsRoot)
    expect(sessions.map(s => s.sessionStamp)).toEqual([
      '2026_09_12_17_46_29',
      '2026_08_16_22_21_22',
    ])
  })
})
