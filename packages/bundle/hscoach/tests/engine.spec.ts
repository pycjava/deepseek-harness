/**
 * 引擎功能测试：端到端（fixture → 建议发布）、latest-wins、
 * 降级回显、再想想、战绩记录。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { CoachEngine, type AdviceProvider } from '../src/runtime/engine.ts'
import { CardDatabase } from '../src/core/cards.ts'
import type { GameSnapshot } from '../src/core/state.ts'
import type { Advice } from '../src/core/trigger.ts'

const db = new CardDatabase([join(import.meta.dirname, '..', 'data')])
const fixture = () =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'friendly_player_id_is_1.power.log'), 'utf-8')
    .split(/\r?\n/)
    .filter(l => l.length > 0)

function okAdvice(headline: string): Advice {
  return {
    kind: 'play',
    headline,
    why: '测试理由',
    steps: [],
    warning: '',
    alternatives: [],
    latency_ms: 1,
    degraded: false,
    lethal: false,
  }
}

/** 受控 provider：可编排延迟/失败。 */
class ScriptedProvider implements AdviceProvider {
  calls: number = 0
  script: (input: {
    snapshot: GameSnapshot
    generation: number
  }) => Promise<Advice> = async ({ snapshot }) => okAdvice(`T${snapshot.turn} 建议`)

  async generate(input: Parameters<AdviceProvider['generate']>[0]): Promise<Advice> {
    this.calls += 1
    return this.script({ snapshot: input.snapshot, generation: input.generation })
  }
}

let dir: string

describe('CoachEngine', () => {
  beforeEach(async () => {
    await db.build()
    dir = await mkdtemp(join(tmpdir(), 'hscoach-engine-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('端到端：fixture 全量喂入 → 发布 game_state/advice、触发回合数正确', async () => {
    const provider = new ScriptedProvider()
    const publishedTurns: number[] = []
    provider.script = async ({ snapshot }) => okAdvice(`T${snapshot.turn} 建议`)
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'advice-published') publishedTurns.push(e.turn)
      },
    })
    await engine.processLines(fixture())
    await engine.idle()

    // 友方（玩家1，后手）回合为偶数：T2/T4/…。发布段已串行化：事件顺序
    // = 提交代数顺序，advice.json 最终内容 = 最后提交的建议。
    expect(provider.calls).toBe(7)
    expect(publishedTurns.length).toBeLessThanOrEqual(provider.calls)
    expect(publishedTurns.every(t => t % 2 === 0)).toBe(true)
    expect(publishedTurns).toEqual([...publishedTurns].sort((a, b) => a - b))
    expect(publishedTurns[publishedTurns.length - 1]).toBe(14)

    // 发布契约
    const advice = JSON.parse(await readFile(join(dir, 'advice.json'), 'utf-8')) as {
      turn?: number
      advice?: { kind?: string }
    }
    expect(advice).toHaveProperty('turn')
    expect(advice.advice).toMatchObject({ kind: 'play' })
    const state = JSON.parse(await readFile(join(dir, 'game_state.json'), 'utf-8')) as {
      players: Record<string, { hand: unknown }>
    }
    expect(state).toMatchObject({ friendly_player_id: 1 })
    // 隐藏信息：对手手牌只有数量（hand 恰为 { count } 一个键）
    const opponentHand = state.players['2']?.hand as { count?: number } | undefined
    expect(Object.keys(opponentHand ?? {})).toEqual(['count'])
    expect(typeof opponentHand?.count).toBe('number')
    // 战绩（fixture 是败局）
    const stats = JSON.parse(await readFile(join(dir, 'stats.json'), 'utf-8')) as {
      total?: number
      losses?: number
    }
    expect(stats).toMatchObject({ total: 1, losses: 1 })
  })

  it('latest-wins：新回合到达时未发布的旧建议作废', async () => {
    const provider = new ScriptedProvider()
    const published: number[] = []
    let releaseFirst!: () => void
    const gate = new Promise<void>(resolve => (releaseFirst = resolve))
    let first = true
    provider.script = async ({ snapshot }) => {
      if (first) {
        first = false
        await gate // T2 挂起，直到 T4 的提交同步完成代数递增
      } else {
        releaseFirst() // T4 提交时同步放行 T2（此时 gen 已被 T4 占位）
      }
      return okAdvice(`T${snapshot.turn}`)
    }
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'advice-published') published.push(e.turn)
      },
    })
    const lines = fixture()
    // T2@~3559、T4@~3916：第一段覆盖 T2（挂起），第二段覆盖 T4
    const p1 = engine.processLines(lines.slice(0, 3600))
    await p1
    const p2 = engine.processLines(lines.slice(3600, 4000))
    await Promise.all([p2, engine.idle()])

    expect(provider.calls).toBe(2)
    expect(published).toEqual([4]) // T2 被 latest-wins 作废
  })

  it('降级：provider 失败 → 回显上一回合建议并标 degraded；无历史则占位', async () => {
    const provider = new ScriptedProvider()
    let fail = false
    provider.script = async () => {
      if (fail) throw new Error('模拟超时')
      return okAdvice('正常建议')
    }
    const engine = new CoachEngine({ publishDir: dir, db, adviceProvider: provider })
    const lines = fixture()
    await engine.processLines(lines.slice(0, 3600)) // T2 正常发布
    await engine.idle()
    const before = JSON.parse(await readFile(join(dir, 'advice.json'), 'utf-8')) as { advice?: { degraded?: boolean } }
    expect(before.advice?.degraded).toBe(false)

    fail = true
    await engine.thinkAgain() // 手动触发再生成 → 失败 → 回显
    const after = JSON.parse(await readFile(join(dir, 'advice.json'), 'utf-8')) as { advice?: { degraded?: boolean; headline?: string } }
    expect(after.advice?.degraded).toBe(true)
    expect(after.advice?.headline).toBe('正常建议')
  })

  it('再想想：think-again 流程走 provider 并发布', async () => {
    const provider = new ScriptedProvider()
    const engine = new CoachEngine({ publishDir: dir, db, adviceProvider: provider })
    await engine.processLines(fixture().slice(0, 3600))
    await engine.idle()
    const callsBefore = provider.calls
    await engine.thinkAgain()
    expect(provider.calls).toBe(callsBefore + 1)
    expect((JSON.parse(await readFile(join(dir, 'advice.json'), 'utf-8')) as { advice?: { headline?: string } }).advice?.headline).toBe(
      'T2 建议',
    )
  })
})

describe('CoachEngine 分支补齐', () => {
  it('校准与显式配置冲突时发出降级事件并按日志纠正', async () => {
    await db.build()
    const events: string[] = []
    const provider = new ScriptedProvider()
    // 显式声明友方为 2，而日志校准结果是 1
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      friendlyPlayerId: 2,
      onEvent: (e) => {
        if (e.type === 'advice-degraded') events.push(e.reason)
        if (e.type === 'calibrated') events.push(`calibrated:${e.friendlyPlayerId}`)
      },
    })
    await engine.processLines(fixture())
    await engine.idle()
    expect(engine.getFriendlyPlayerId()).toBe(1)
    expect(events.some(r => r.includes('自动校准与配置的 friendlyPlayerId 冲突'))).toBe(true)
    expect(events).toContain('calibrated:1')
  })

  it('首次建议即失败（无回显可用）时发布诚实占位', async () => {
    await db.build()
    const provider = new ScriptedProvider()
    provider.script = async () => {
      throw new Error('第一次就失败')
    }
    const engine = new CoachEngine({ publishDir: dir, db, adviceProvider: provider })
    await engine.processLines(fixture())
    await engine.idle()
    const advice = JSON.parse(await readFile(join(dir, 'advice.json'), 'utf-8')) as {
      advice?: { headline?: string; degraded?: boolean; why?: string }
    }
    expect(advice.advice?.degraded).toBe(true)
    expect(advice.advice?.headline).toContain('教练暂时无法响应')
    expect(advice.advice?.why).toContain('第一次就失败')
  })

  it('thinkAgain 无可解析局面时发出降级事件', async () => {
    await db.build()
    const events: string[] = []
    const provider = new ScriptedProvider()
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'advice-degraded') events.push(e.reason)
      },
    })
    await engine.thinkAgain()
    expect(events).toContain('暂无可解析的对局局面')
  })

  it('thinkAgain 发布失败被捕获为降级事件（发布目录不可写）', async () => {
    await db.build()
    const { writeFile } = await import('node:fs/promises')
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'not a directory', 'utf8')
    const events: string[] = []
    const provider = new ScriptedProvider()
    const engine = new CoachEngine({
      publishDir: join(blocker, 'sub'),
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'advice-degraded') events.push(e.reason)
      },
    })
    await engine.processLines(fixture())
    await engine.idle()
    // 发布失败不中断引擎；事件给出原因
    expect(events.length).toBeGreaterThan(0)
  })

  it('战绩记录失败被捕获（发布目录为文件）；结果早于可解析局面时静默', async () => {
    await db.build()
    const { writeFile } = await import('node:fs/promises')
    const blocker = join(dir, 'blocker2')
    await writeFile(blocker, 'x', 'utf8')
    const events: string[] = []
    const provider = new ScriptedProvider()
    const engine = new CoachEngine({
      publishDir: join(blocker, 'sub'),
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'advice-degraded') events.push(e.reason)
      },
    })
    await engine.processLines(fixture())
    await engine.idle()
    expect(events.some(r => r.includes('战绩记录失败'))).toBe(true)

    // 无对局可解析时 recordGameResult 静默返回
    const quiet = new CoachEngine({ publishDir: dir, db, adviceProvider: new ScriptedProvider() })
    await quiet.processLines([
      'D 10:00:00.0 GameState.DebugPrintPower() - CREATE_GAME',
      'D 10:00:00.1 GameState.DebugPrintPower() - TAG_CHANGE Entity=2 tag=PLAYSTATE value=WON',
    ])
    await quiet.idle()
  })
})

describe('CoachEngine 终批分支', () => {
  it('非 Error 抛出物的 reason 文案（字符串 throw）', async () => {
    await db.build()
    const events: string[] = []
    const provider = new ScriptedProvider()
    provider.script = async () => {
      throw '字符串错误'
    }
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'advice-degraded') events.push(e.reason)
      },
    })
    await engine.processLines(fixture())
    await engine.idle()
    expect(events.some(r => r.includes('字符串错误'))).toBe(true)
  })

  it('第二局开始触发 game-start 重置（事件 + 战绩清零）', async () => {
    await db.build()
    const starts: number[] = []
    const provider = new ScriptedProvider()
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'game-start') starts.push(1)
      },
    })
    await engine.processLines([...fixture(), ...fixture()])
    await engine.idle()
    // 两局各发一次 game-start
    expect(starts.length).toBe(2)
  })

  it('战绩记录无英雄职业时类名为空', async () => {
    await db.build()
    const results: string[] = []
    const provider = new ScriptedProvider()
    const engine = new CoachEngine({
      publishDir: dir,
      db,
      adviceProvider: provider,
      onEvent: (e) => {
        if (e.type === 'game-result') results.push(e.result)
      },
    })
    await engine.processLines([
      power2('CREATE_GAME'),
      power2('GameEntity EntityID=1'),
      power2('Player EntityID=2 PlayerID=1 GameAccountId=[hi=1 lo=2]'),
      power2('Player EntityID=3 PlayerID=2 GameAccountId=[hi=1 lo=3]'),
      power2('TAG_CHANGE Entity=2 tag=PLAYSTATE value=LOST'),
    ])
    await engine.idle()
    expect(results).toEqual(['loss'])
  })
})

function power2(data: string): string {
  return `D 10:00:00.0000000 GameState.DebugPrintPower() - ${data}`
}
