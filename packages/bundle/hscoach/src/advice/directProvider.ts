/**
 * 直连 LLM API 建议生成器：单次 chat/completions 调用 + JSON 输出。
 * 不经宿主 agents 服务——插件自包含，任何 dsh profile 均可运行。
 * 失败抛 ProviderError，由引擎降级（上回合建议回显）。
 *
 * 底层 HTTP 调用（watchdog 超时 / 非 200 / 推理截断重试）由
 * ./chatCompletion.ts 的 requestChatContent 统一处理；这里只负责
 * prompt 组装与 JSON → Advice 契约的归一化。
 */
import { computeLethal, type LethalCheck } from '../core/lethal.ts'
import { snapshotToContract, type GameSnapshot } from '../core/state.ts'
import { emptyAdvice, type Advice } from '../core/trigger.ts'
import {
  ProviderError,
  requestChatContent,
  type ChatCompletionDeps,
} from './chatCompletion.ts'
import { buildUserPrompt, getSystemPrompt, type ChatTurn } from './prompts.ts'
import type { AdviceProvider } from '../runtime/engine.ts'

// 兼容导出：既有调用方（含测试）从本模块取 ProviderError 与 fetch 结构类型。
export { ProviderError } from './chatCompletion.ts'
export type { FetchLike, RequestInitLike, ResponseLike } from './chatCompletion.ts'

/** 直连 provider 的构造依赖（API 端点、鉴权、模型、超时与输出预算）。 */
export type DirectProviderDeps = ChatCompletionDeps

/** 直连 LLM API 的建议生成器实现（单次 chat/completions + JSON 输出 + watchdog 超时）。 */
export class DirectApiAdviceProvider implements AdviceProvider {
  constructor(private readonly deps: DirectProviderDeps) {}

  async generate(input: {
    snapshot: GameSnapshot
    friendlyPlayerId: number
    lethal: LethalCheck | null
    coachMode: string
    generation: number
    recentChat?: readonly ChatTurn[]
  }): Promise<Advice> {
    const { snapshot, friendlyPlayerId } = input
    if (!this.deps.apiKey) {
      throw new ProviderError('未配置 LLM API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）')
    }
    const lethalCheck = input.lethal ?? computeLethal(snapshot, friendlyPlayerId)
    const system = getSystemPrompt(input.coachMode)
    const user = buildUserPrompt(
      snapshotToContract(snapshot),
      friendlyPlayerId,
      lethalCheck,
      input.recentChat,
    )
    const start = Date.now()

    const content = await requestChatContent(this.deps, {
      system,
      user,
      jsonMode: true,
      label: 'LLM API',
    })
    const payload = parseJsonContent(content)
    if (payload === null) {
      throw new ProviderError('模型响应不是合法 JSON')
    }
    const advice = toAdvice(payload)
    advice.latency_ms = Date.now() - start
    return advice
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

/** 模型 JSON 输出中一个 alternatives 条目的宽松形状。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
