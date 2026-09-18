/**
 * 回归钉（黄金快照逐字段比对）。
 *
 * 黄金快照为冻结基准：TS 核心是唯一实现，本测试钉死确定性核心的
 * 行为不回归。fixture 为外服标准日志（15 触发回合、友方玩家 id=1），
 * 已脱敏（无真实玩家名）。上游曾有一份国服双局日志的第二个用例，
 * 但其 Power.log 从未入库（作者本地隐私文件），无法迁移，故不移植。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CardDatabase } from '../src/core/cards.ts'
import { GameResultDetector } from '../src/core/history.ts'
import { computeLethal } from '../src/core/lethal.ts'
import { parsePowerLog } from '../src/core/parser.ts'
import { calibrateFriendlyPlayer, serializeGame, snapshotToContract } from '../src/core/state.ts'
import { IncrementalTurnDetector } from '../src/core/trigger.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')
const GOLDEN = join(HERE, 'golden')

interface GoldenFile {
  fixture: string
  friendly_player_id: number
  triggered_turns: number[]
  turns: Array<{
    turn: number
    friendly_player_id: number
    snapshot: Record<string, unknown>
    lethal: Record<string, unknown>
  }>
  game_results: string[]
}

const db = new CardDatabase([join(HERE, '..', 'data')])

/** 与黄金快照生成时完全一致的管线（批处理边界逐行对齐）。 */
function runPipeline(lines: string[]) {
  const detector = new IncrementalTurnDetector(1, false)
  let friendlyPlayerId = 1
  const turns: Array<{
    turn: number
    friendlyPlayerId: number
    snapshot: unknown
    lethal: ReturnType<typeof computeLethal>
  }> = []
  let batch: string[] = []
  for (const line of lines) {
    batch.push(line)
    if (batch.length >= 50 || line.includes('TAG_CHANGE')) {
      const triggered = detector.feed(batch)
      batch = []
      for (const turn of triggered) {
        const result = parsePowerLog(detector.getTriggerWindow(turn))
        if (result.games.length === 0) continue
        const game = result.games[result.games.length - 1]
        if (game === undefined) continue
        const calibrated = calibrateFriendlyPlayer(game)
        if (calibrated !== null) friendlyPlayerId = calibrated
        const snapshot = serializeGame(game, friendlyPlayerId, db)
        const lethal = computeLethal(snapshot, friendlyPlayerId)
        turns.push({
          turn,
          friendlyPlayerId,
          snapshot: snapshotToContract(snapshot),
          lethal,
        })
      }
    }
  }
  return { detector, friendlyPlayerId, turns }
}

describe.each([
  ['friendly_player_id_is_1.power', '外服标准日志'],
])('对拍：%s（%s）', (stem) => {
  it('快照/斩杀/触发回合/终局与黄金快照逐字段一致', async () => {
    await db.build()
    const golden = JSON.parse(
      readFileSync(join(GOLDEN, `${stem}.golden.json`), 'utf-8'),
    ) as GoldenFile
    const lines = readFileSync(join(FIXTURES, `${stem}.log`), 'utf-8').split(/\r?\n/)

    const { turns, friendlyPlayerId } = runPipeline(lines)

    // 触发回合序列一致（含国服 prefilter=false 的全部新回合）
    expect(turns.map(t => t.turn)).toEqual(golden.triggered_turns)
    expect(turns.length).toBe(golden.turns.length)

    for (let i = 0; i < golden.turns.length; i++) {
      const gold = golden.turns[i]
      const mine = turns[i]
      if (gold === undefined || mine === undefined) throw new Error(`turns[${i}] 缺失`)
      expect(mine.turn, `turns[${i}].turn`).toBe(gold.turn)
      expect(mine.friendlyPlayerId, `turns[${i}].friendly`).toBe(gold.friendly_player_id)
      // 快照逐字段（JSON 序列化后比对，避免键序干扰）
      expect(JSON.parse(JSON.stringify(mine.snapshot)), `turns[${i}].snapshot`).toEqual(
        gold.snapshot,
      )
      // 斩杀结果逐字段
      expect(
        {
          available_damage: mine.lethal.availableDamage,
          lethal: mine.lethal.lethal,
          detail: mine.lethal.detail,
          deficit: mine.lethal.deficit,
          taunt_blocked: mine.lethal.tauntBlocked,
          taunt_cost: mine.lethal.tauntCost,
          opponent_fatigue_damage: mine.lethal.opponentFatigueDamage,
          summary: mine.lethal.summary(),
        },
        `turns[${i}].lethal`,
      ).toEqual(gold.lethal)
    }

    // 终局结果（以最终校准的友方 id 全量重放）
    const detector = new GameResultDetector(friendlyPlayerId)
    const results = detector.feed(lines)
    expect(results).toEqual(golden.game_results)
    expect(friendlyPlayerId).toBe(golden.friendly_player_id)
  })
})
