/**
 * 直连 LLM API 建议生成器：单次 chat/completions 调用 + JSON 输出 +
 * watchdog 超时（AbortController）。不经宿主 agents 服务——插件自包含，
 * 任何 dsh profile 均可运行。失败抛 ProviderError，由引擎降级
 * （上回合建议回显）。
 */
import { computeLethal, type LethalCheck } from '../core/lethal.ts'
import { snapshotToContract, type GameSnapshot } from '../core/state.ts'
import { emptyAdvice, type Advice } from '../core/trigger.ts'
import { buildUserPrompt, getSystemPrompt } from './prompts.ts'
import type { AdviceProvider } from '../runtime/engine.ts'

/** 直连 LLM API 调用失败（网络、超时、非 200、响应不合法）时抛出的错误类型。 */
export class ProviderError extends Error {}

/** 直连 provider 的构造依赖（API 端点、鉴权、模型与超时配置）。 */
export interface DirectProviderDeps {
  /** DeepSeek 兼容 API 根地址（如 https://api.deepseek.com，不带尾斜杠）。 */
  baseURL: string
  apiKey: string
  model: string
  /** watchdog 上限（毫秒）。 */
  timeoutMs: number
  /** HTTP 实现（测试注入桩；需响应 signal 中止）。 */
  fetchImpl?: FetchLike | undefined
}

/** fetch 的最小结构类型（避免依赖 DOM lib；全局 fetch 结构兼容）。 */
export interface FetchLike {
  (url: string, init?: RequestInitLike): Promise<ResponseLike>
}

/** fetch 请求初始化参数的最小结构类型。 */
export interface RequestInitLike {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

/** fetch 响应的最小结构类型。 */
export interface ResponseLike {
  ok: boolean
  status: number
  statusText?: string
  json(): Promise<unknown>
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>
}

/** 模型 JSON 输出中一个 alternatives 条目的宽松形状。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 直连 LLM API 的建议生成器实现（单次 chat/completions + JSON 输出 + watchdog 超时）。 */
export class DirectApiAdviceProvider implements AdviceProvider {
  constructor(private readonly deps: DirectProviderDeps) {}

  async generate(input: {
    snapshot: GameSnapshot
    friendlyPlayerId: number
    lethal: LethalCheck | null
    coachMode: string
    generation: number
  }): Promise<Advice> {
    const { snapshot, friendlyPlayerId } = input
    if (!this.deps.apiKey) {
      throw new ProviderError('未配置 LLM API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）')
    }
    const lethalCheck = input.lethal ?? computeLethal(snapshot, friendlyPlayerId)
    const system = getSystemPrompt(input.coachMode)
    const user = buildUserPrompt(snapshotToContract(snapshot), friendlyPlayerId, lethalCheck)
    const start = Date.now()

    const content = await this.chatJson(system, user)
    const payload = parseJsonContent(content)
    if (payload === null) {
      throw new ProviderError('模型响应不是合法 JSON')
    }
    const advice = toAdvice(payload)
    advice.latency_ms = Date.now() - start
    return advice
  }

  /** 单次 chat 调用，返回 message.content；超时/非 200/空响应抛 ProviderError。 */
  private async chatJson(system: string, user: string): Promise<string> {
    const controller = new AbortController()
    const watchdog = setTimeout(() => {
      controller.abort()
    }, this.deps.timeoutMs)
    let response: ResponseLike
    try {
      response = await (this.deps.fetchImpl ?? fetch)(
        `${this.deps.baseURL.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.deps.apiKey}`,
          },
          body: JSON.stringify({
            model: this.deps.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: { type: 'json_object' },
            max_tokens: 4096,
            stream: false,
          }),
          signal: controller.signal,
        },
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderError(`建议生成超时（${this.deps.timeoutMs}ms）`)
      }
      throw new ProviderError(`LLM API 请求失败：${String(error)}`)
    } finally {
      clearTimeout(watchdog)
    }
    if (!response.ok) {
      throw new ProviderError(`LLM API 返回 ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
    }
    const body = (await response.json()) as ChatCompletionResponse
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      throw new ProviderError('LLM API 响应缺少 choices[0].message.content')
    }
    return content
  }
}

/**
 * 从模型输出中提取 JSON：直接解析，失败则截取首尾花括号之间再试。
 * @param content - 模型原始输出文本（可能带 ```json 围栏或前后解释文字）。
 * @returns 解析出的 JSON 值；全部候选解析失败时返回 null。
 */
export function parseJsonContent(content: string): unknown {
  const trimmed = content.trim()
  const candidates = [trimmed]
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const fencedBody = fenced?.[1]
  if (fencedBody !== undefined) candidates.push(fencedBody)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

/**
 * 模型 JSON 输出 → Advice 契约（模型输出是外部输入边界，逐字段收窄；
 * 标量字段按原始语义强制转换为字符串，坏值降级不抛）。
 * @param payload - parseJsonContent 解出的任意 JSON 值。
 * @returns 归一化的 Advice（非法字段回退默认值）。
 */
export function toAdvice(payload: unknown): Advice {
  const advice = emptyAdvice()
  const source = isRecord(payload) ? payload : {}
  const str = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : ''
  const kind = str(source.kind)
  advice.kind =
    kind === 'play' || kind === 'trade' || kind === 'pass' || kind === 'uncertain'
      ? kind
      : 'uncertain'
  advice.headline = str(source.headline)
  advice.why = str(source.why)
  advice.steps = Array.isArray(source.steps)
    ? source.steps.filter((step): step is string => typeof step === 'string')
    : []
  advice.warning = str(source.warning)
  advice.alternatives = Array.isArray(source.alternatives)
    ? source.alternatives
      .filter(isRecord)
      .map(a => ({
        headline: str(a.headline),
        why: str(a.why),
      }))
    : []
  return advice
}
