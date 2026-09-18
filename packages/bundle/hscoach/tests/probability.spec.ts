/**
 * 抽牌概率（超几何分布）单元测试：边界退化、精确值与可读文案。
 */
import { describe, expect, it } from 'vitest'
import {
  drawAtLeastOne,
  drawExact,
  drawOddsTable,
  drawProbabilitySummary,
} from '../src/core/probability.ts'

describe('drawExact', () => {
  it('退化输入：空牌库/无目标/零抽牌', () => {
    expect(drawExact(0, 2, 1, 1)).toBe(0)
    expect(drawExact(0, 2, 1, 0)).toBe(1)
    expect(drawExact(30, 0, 1, 1)).toBe(0)
    expect(drawExact(30, 2, 0, 1)).toBe(0)
    expect(drawExact(30, 2, 0, 0)).toBe(1)
  })

  it('越界 k 返回 0；抽牌数夹到牌库大小', () => {
    expect(drawExact(30, 2, 1, -1)).toBe(0)
    expect(drawExact(30, 2, 1, 3)).toBe(0)
    expect(drawExact(2, 2, 99, 2)).toBeCloseTo(1, 10)
    expect(drawExact(2, 2, 99, 0)).toBeCloseTo(0, 10)
  })

  it('超几何精确值', () => {
    // 30 张含 2 张，抽 1 张恰好抽到 1 张：2/30
    expect(drawExact(30, 2, 1, 1)).toBeCloseTo(2 / 30, 12)
    // 4 张含 2 张，抽 2 张恰好都抽到：C(2,2)*C(2,0)/C(4,2) = 1/6
    expect(drawExact(4, 2, 2, 2)).toBeCloseTo(1 / 6, 12)
  })
})

describe('drawAtLeastOne', () => {
  it('退化与必得情形', () => {
    expect(drawAtLeastOne(0, 2, 1)).toBe(0)
    expect(drawAtLeastOne(30, 0, 1)).toBe(0)
    expect(drawAtLeastOne(30, 2, 0)).toBe(0)
    expect(drawAtLeastOne(2, 2, 1)).toBe(1)
    expect(drawAtLeastOne(10, 4, 9)).toBe(1)
  })

  it('至少一张的概率', () => {
    expect(drawAtLeastOne(30, 2, 1)).toBeCloseTo(2 / 30, 12)
    expect(drawAtLeastOne(30, 1, 1)).toBeCloseTo(1 / 30, 12)
  })
})

describe('drawProbabilitySummary', () => {
  it('无效输入的 0% 文案与单/多回合措辞', () => {
    expect(drawProbabilitySummary(0, 2)).toContain('抽到概率 0%')
    expect(drawProbabilitySummary(30, 0)).toContain('抽到概率 0%')
    expect(drawProbabilitySummary(30, 2, 0)).toContain('抽到概率 0%')
    expect(drawProbabilitySummary(30, 2)).toContain('下回合抽到概率')
    expect(drawProbabilitySummary(30, 2, 3)).toContain('未来 3 回合')
    expect(drawProbabilitySummary(30, 2)).toContain('（牌库 30 张含 2 张目标）')
  })
})

describe('drawOddsTable', () => {
  it('单张/双张目标的下回合参考', () => {
    const odds = drawOddsTable(20)
    expect(odds.one_copy_next_draw).toBeCloseTo(1 / 20, 12)
    expect(odds.two_copy_next_draw).toBeCloseTo(2 / 20, 12)
  })
})
