/**
 * 直连 provider 功能测试：请求形态（URL/鉴权/JSON 模式）、响应解析
 * （围栏/夹带 JSON）、watchdog 超时、错误路径、toAdvice 粗化、隐藏信息。
 */
import { describe, expect, it } from 'vitest'
import {
  DirectApiAdviceProvider,
  ProviderError,
  parseJsonContent,
  toAdvice,
  type FetchLike,
  type ResponseLike,
} from '../src/advice/directProvider.ts'
import { buildUserPrompt, getSystemPrompt } from '../src/advice/prompts.ts'
import { computeLethal } from '../src/core/lethal.ts'
import { parsePowerLog } from '../src/core/parser.ts'
import { serializeGame, snapshotToContract, type GameSnapshot } from '../src/core/state.ts'
import type { CardDatabase } from '../src/core/cards.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const emptyDb = {
  get: () => undefined,
  iterCards: () => [],
  has: () => false,
  size: 0,
} as unknown as CardDatabase

/** 从 fixture 抓一个真实快照。 */
function fixtureSnapshot(): { snapshot: GameSnapshot; friendly: number } {
  const lines = readFileSync(
    join(import.meta.dirname, 'fixtures', 'friendly_player_id_is_1.power.log'),
    'utf-8',
  ).split(/\r?\n/)
  const result = parsePowerLog(lines)
  const game = result.games[result.games.length - 1]
  if (game === undefined) throw new Error('fixture 解析失败：没有对局')
  const friendly = game.friendlyPlayerByShow ?? 1
  return { snapshot: serializeGame(game, friendly, emptyDb), friendly }
}

function okResponse(content: string): ResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  }
}

interface Recorded {
  url: string
  init: { headers: Record<string, string>; body: string }
}

function makeRecordingFetch(response: () => Promise<ResponseLike>): {
  fetchImpl: FetchLike
  recorded: Recorded[]
} {
  const recorded: Recorded[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    recorded.push({ url, init: { headers: init?.headers ?? {}, body: init?.body ?? '' } })
    return response()
  }
  return { fetchImpl, recorded }
}

function makeProvider(
  fetchImpl: FetchLike,
  overrides: Partial<ConstructorParameters<typeof DirectApiAdviceProvider>[0]> = {},
) {
  return new DirectApiAdviceProvider({
    baseURL: 'http://llm.test/',
    apiKey: 'test-key',
    model: 'test-model',
    timeoutMs: 15_000,
    fetchImpl,
    ...overrides,
  })
}

function generateWith(provider: DirectApiAdviceProvider) {
  const { snapshot, friendly } = fixtureSnapshot()
  return provider.generate({
    snapshot,
    friendlyPlayerId: friendly,
    lethal: null,
    coachMode: 'teach',
    generation: 1,
  })
}

describe('DirectApiAdviceProvider', () => {
  it('单次调用：URL 拼接/鉴权/JSON 模式/prompt 注入 → Advice + 延迟', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(async () =>
      okResponse(
        JSON.stringify({
          kind: 'play',
          headline: '火球术打脸',
          why: '斩杀评估已确认',
          steps: ['火球术 → 对方英雄'],
        }),
      ),
    )
    const provider = makeProvider(fetchImpl)
    const advice = await generateWith(provider)

    expect(advice.kind).toBe('play')
    expect(advice.headline).toBe('火球术打脸')
    expect(advice.steps).toEqual(['火球术 → 对方英雄'])
    expect(advice.degraded).toBe(false)
    expect(advice.latency_ms).toBeGreaterThanOrEqual(0)

    expect(recorded.length).toBe(1)
    expect(recorded[0]!.url).toBe('http://llm.test/chat/completions')
    expect(recorded[0]!.init.headers.authorization).toBe('Bearer test-key')
    const body = JSON.parse(recorded[0]!.init.body) as {
      model?: string
      response_format?: unknown
      stream?: boolean
      messages?: Array<{ role?: string; content?: string }>
    }
    expect(body.model).toBe('test-model')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.stream).toBe(false)
    expect(body.messages).toHaveLength(2)
    expect(body.messages?.[0]?.role).toBe('system')
    expect(body.messages?.[0]?.content).toContain('只输出最终 JSON')
    expect(body.messages?.[1]?.content).toContain('=== 当前回合')
  })

  it('recentChat 进入建议 user prompt', async () => {
    const { fetchImpl, recorded } = makeRecordingFetch(async () =>
      okResponse(JSON.stringify({ kind: 'pass', headline: '过', why: '测试' })),
    )
    const { snapshot, friendly } = fixtureSnapshot()
    await makeProvider(fetchImpl).generate({
      snapshot,
      friendlyPlayerId: friendly,
      lethal: null,
      coachMode: 'teach',
      generation: 1,
      recentChat: [{ role: 'user', text: '为什么不出伊瑟拉' }],
    })
    const body = JSON.parse(recorded[0]!.init.body) as {
      messages?: Array<{ role?: string; content?: string }>
    }
    const user = body.messages?.find(m => m.role === 'user')?.content ?? ''
    expect(user).toContain('【最近对话】')
    expect(user).toContain('玩家：为什么不出伊瑟拉')
  })

  it('围栏与夹带文本的 JSON 输出都能解析', async () => {
    const fenced = '```json\n' + JSON.stringify({ kind: 'pass', headline: '过', why: '没事可做' }) + '\n```'
    const p1 = makeProvider(makeRecordingFetch(async () => okResponse(fenced)).fetchImpl)
    expect((await generateWith(p1)).headline).toBe('过')

    const noisy = '好的，我的建议如下：\n' + JSON.stringify({ kind: 'pass', headline: '解场', why: '场面优先' }) + '\n希望有帮助'
    const p2 = makeProvider(makeRecordingFetch(async () => okResponse(noisy)).fetchImpl)
    expect((await generateWith(p2)).headline).toBe('解场')
  })

  it('非 200 / 缺 content / 非法 JSON / 无 key → ProviderError（引擎降级）', async () => {
    const p500 = makeProvider(
      makeRecordingFetch(async () => ({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: async () => ({}),
      })).fetchImpl,
    )
    await expect(generateWith(p500)).rejects.toThrow(ProviderError)
    await expect(generateWith(p500)).rejects.toThrow(/500/)

    // 空 content 在 provider 内是"缺少 content"错误
    const pEmpty = makeProvider(makeRecordingFetch(async () => okResponse('')).fetchImpl)
    await expect(generateWith(pEmpty)).rejects.toThrow(ProviderError)

    const pBad = makeProvider(makeRecordingFetch(async () => okResponse('完全不是 JSON')).fetchImpl)
    await expect(generateWith(pBad)).rejects.toThrow(/不是合法 JSON/)

    const pNoKey = makeProvider(
      makeRecordingFetch(async () => okResponse('{}')).fetchImpl,
      { apiKey: '' },
    )
    await expect(generateWith(pNoKey)).rejects.toThrow(/API key/)
  })

  it('watchdog 超时（fetch 响应 signal 中止）→ ProviderError', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>{  reject(new Error('aborted')) })
      })
    const provider = makeProvider(hanging, { timeoutMs: 30 })
    await expect(generateWith(provider)).rejects.toThrow(/超时/)
  })

  it('推理截断（finish_reason=length 空 content）→ 2 倍预算重试一次', async () => {
    const adviceJson = JSON.stringify({ kind: 'play', headline: '下怪', why: '抢节奏' })
    const responses = [
      { choices: [{ finish_reason: 'length', message: { content: '' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: adviceJson } }] },
    ]
    const { fetchImpl, recorded } = makeRecordingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }))
    const advice = await generateWith(makeProvider(fetchImpl))
    expect(advice.headline).toBe('下怪')
    expect(recorded.length).toBe(2)
    const budgets = recorded.map(r => (JSON.parse(r.init.body) as { max_tokens?: number }).max_tokens)
    expect(budgets).toEqual([8192, 16_384])
  })

  it('重试仍截断 → ProviderError 提示 max_tokens；非截断空响应不重试', async () => {
    const alwaysLength = makeProvider(makeRecordingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '' } }] }),
    })).fetchImpl)
    await expect(generateWith(alwaysLength)).rejects.toThrow(/截断/)

    const { fetchImpl, recorded } = makeRecordingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
    }))
    await expect(generateWith(makeProvider(fetchImpl))).rejects.toThrow(/缺少 choices/)
    expect(recorded.length).toBe(1)
  })

  it('显式 maxTokens 覆盖默认预算，重试在其上翻倍', async () => {
    const responses = [
      { choices: [{ finish_reason: 'length', message: { content: '' } }] },
      { choices: [{ finish_reason: 'stop', message: { content: '{"kind":"pass","headline":"过"}' } }] },
    ]
    const { fetchImpl, recorded } = makeRecordingFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => responses.shift(),
    }))
    await generateWith(makeProvider(fetchImpl, { maxTokens: 1000 }))
    const budgets = recorded.map(r => (JSON.parse(r.init.body) as { max_tokens?: number }).max_tokens)
    expect(budgets).toEqual([1000, 2000])
  })

  it('user prompt 含局面与斩杀评估，且不含对手手牌明细（隐藏信息）', () => {
    const { snapshot, friendly } = fixtureSnapshot()
    const user = buildUserPrompt(snapshotToContract(snapshot), friendly, computeLethal(snapshot, friendly))
    expect(user).toContain('=== 当前回合')
    expect(user).toContain('【伤害评估】')
    expect(user).toContain('张（隐藏，不知具体）')
    // 快照本体也不应有对手手牌卡牌对象
    const opponent = snapshot.players[String(friendly === 1 ? 2 : 1)]
    expect(Array.isArray(opponent?.hand)).toBe(false)
    expect(getSystemPrompt('teach')).toContain('只输出最终 JSON')
  })

  it('parseJsonContent：直取/围栏/截取三级候选', () => {
    expect(parseJsonContent('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonContent('  ```json\n{"a":2}\n``` ')).toEqual({ a: 2 })
    expect(parseJsonContent('前缀 {"a":3} 后缀')).toEqual({ a: 3 })
    expect(parseJsonContent('毫无花括号')).toBeNull()
  })

  it('toAdvice：非法 kind 降级 uncertain，steps/alternatives 粗化', () => {
    const advice = toAdvice({
      kind: '绝杀',
      headline: 'x',
      why: 'y',
      steps: 'not-array',
      alternatives: [{ headline: 1, why: null }, null],
    })
    expect(advice.kind).toBe('uncertain')
    expect(advice.steps).toEqual([])
    expect(advice.alternatives).toEqual([{ headline: '1', why: '' }])
    expect(advice.latency_ms).toBe(0)
    expect(advice.degraded).toBe(false)
  })
})

describe('DirectApiAdviceProvider 网络分支', () => {
  it('未注入 fetchImpl 时走全局 fetch；本地拒绝连接快速失败', async () => {
    const provider = new DirectApiAdviceProvider({
      baseURL: 'http://127.0.0.1:9',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 2000,
    })
    await expect(provider.generate({
      snapshot: fixtureSnapshot().snapshot,
      friendlyPlayerId: 1,
      lethal: null,
      coachMode: 'teach',
      generation: 1,
    })).rejects.toThrow(/请求失败|超时/)
  })

  it('非 200 响应无 statusText 也能给出信息', async () => {
    const provider = new DirectApiAdviceProvider({
      baseURL: 'http://x.test',
      apiKey: 'k',
      model: 'm',
      timeoutMs: 1000,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    })
    await expect(provider.generate({
      snapshot: fixtureSnapshot().snapshot,
      friendlyPlayerId: 1,
      lethal: null,
      coachMode: 'teach',
      generation: 1,
    })).rejects.toThrow('500')
  })

  it('toAdvice 标量强制转换：数字 headline / null why', () => {
    const advice = toAdvice({ kind: 'pass', headline: 7, why: null, alternatives: [{ headline: 1, why: false }] })
    expect(advice.headline).toBe('7')
    expect(advice.why).toBe('')
    expect(advice.alternatives).toEqual([{ headline: '1', why: 'false' }])
  })
})

describe('toAdvice 非对象载荷', () => {
  it('字符串/null 载荷回退全默认字段', () => {
    expect(toAdvice('nonsense')).toMatchObject({ kind: 'uncertain', headline: '', steps: [] })
    expect(toAdvice(null)).toMatchObject({ kind: 'uncertain', why: '' })
  })
})
