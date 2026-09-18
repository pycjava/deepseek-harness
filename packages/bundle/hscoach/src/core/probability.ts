/**
 * 抽牌概率（超几何分布）。
 *
 * 纯组合数学：P(至少抽到 1 张) = 1 - C(N-K, n) / C(N, n)。
 * N ≤ 60 时组合数在 double 精度内（C(60,30) ≈ 1.18e17 < 2^53 ≈ 9e15
 * ——超出！故用 BigInt 计算后转 float 做比值，避免精度损失）。
 */

function comb(n: number, k: number): bigint {
  if (n < 0 || k < 0 || k > n) return 0n
  let result = 1n
  for (let i = 0; i < k; i++) {
    result = (result * BigInt(n - i)) / BigInt(i + 1)
  }
  return result
}

/**
 * P(draws 次抽牌中恰好抽到 k 张目标牌)。
 * @param deckSize - 牌库剩余张数。
 * @param copies - 牌库中目标牌张数。
 * @param draws - 抽牌次数。
 * @param k - 恰好抽到的目标牌张数。
 * @returns 恰好抽到 k 张的概率。
 */
export function drawExact(deckSize: number, copies: number, draws: number, k: number): number {
  const N = deckSize
  const K = copies
  let n = draws
  if (N <= 0 || K <= 0 || n <= 0) return k > 0 ? 0 : 1
  n = Math.min(n, N)
  if (k < 0 || k > K || k > n) return 0
  const denom = comb(N, n)
  /* v8 ignore next -- n 已夹到 [1,N]，C(N,n) 恒为正 */
  if (denom === 0n) return 0
  const num = comb(K, k) * comb(N - K, n - k)
  return Number(num) / Number(denom)
}

/**
 * P(draws 次抽牌中至少抽到 1 张目标牌)。
 * @param deckSize - 牌库剩余张数。
 * @param copies - 牌库中目标牌张数。
 * @param draws - 抽牌次数。
 * @returns 至少抽到 1 张的概率。
 */
export function drawAtLeastOne(deckSize: number, copies: number, draws: number): number {
  const N = deckSize
  const K = copies
  let n = draws
  if (N <= 0 || K <= 0 || n <= 0) return 0
  n = Math.min(n, N)
  if (K >= N) return 1
  if (n > N - K) return 1
  const denom = comb(N, n)
  /* v8 ignore next -- n 已夹到 [1,N]，C(N,n) 恒为正 */
  if (denom === 0n) return 0
  const pZero = Number(comb(N - K, n)) / Number(denom)
  return 1 - pZero
}

/**
 * 可读结论："下回合抽到概率 6.7%（牌库 30 张含 2 张目标）"。
 * @param deckSize - 牌库剩余张数。
 * @param copies - 牌库中目标牌张数。
 * @param draws - 抽牌次数；缺省为 1。
 * @returns 可读的概率结论文本。
 */
export function drawProbabilitySummary(deckSize: number, copies: number, draws = 1): string {
  if (deckSize <= 0 || copies <= 0 || draws <= 0) {
    return `抽到概率 0%（牌库 ${deckSize} 张含 ${copies} 张目标）`
  }
  const pct = drawAtLeastOne(deckSize, copies, draws) * 100
  const turnWord = draws === 1 ? '下回合' : `未来 ${draws} 回合`
  return `${turnWord}抽到概率 ${pct.toFixed(1)}%（牌库 ${deckSize} 张含 ${copies} 张目标）`
}

/**
 * 牌库剩余 N 张时下回合抽中 1-of / 2-of 关键牌的概率参考（game_state.json 契约键）。
 * @param deckSize - 牌库剩余张数。
 * @returns 单张/双张目标牌的下回合抽中概率。
 */
export function drawOddsTable(deckSize: number): {
  one_copy_next_draw: number
  two_copy_next_draw: number
} {
  return {
    one_copy_next_draw: drawAtLeastOne(deckSize, 1, 1),
    two_copy_next_draw: drawAtLeastOne(deckSize, 2, 1),
  }
}
