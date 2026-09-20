/**
 * 共享的 chat/completions 单次调用：watchdog 超时（AbortController）+
 * 非 200 / 空响应报错 + **推理截断重试**。
 *
 * 背景：推理型模型（如 deepseek-flash / deepseek-reasoner）的 reasoning
 * tokens 计入 max_tokens。推理把预算耗尽时，API 仍返回 200，但
 * `finish_reason: "length"` 且 `content: ""`——看起来像"响应缺 content"，
 * 实际是输出预算被推理吃完。此类失败按 2 倍预算重试一次（封顶
 * {@link MAX_TOKENS_CAP}）；非截断的空响应（finish_reason=stop 等）不重试。
 */

/** 直连 LLM API 调用失败（网络、超时、非 200、响应不合法）时抛出的错误类型。 */
export class ProviderError extends Error {}

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

/** 单次调用的默认输出预算（tokens）：推理模型需要给思考链留足空间。 */
export const DEFAULT_MAX_TOKENS = 8192

/** 截断重试的预算上限（tokens）。 */
export const MAX_TOKENS_CAP = 16_384

/** 共享 chat 调用的依赖（端点、鉴权、模型、超时与输出预算）。 */
export interface ChatCompletionDeps {
  /** DeepSeek 兼容 API 根地址（如 https://api.deepseek.com，不带尾斜杠）。 */
  baseURL: string
  apiKey: string
  model: string
  /** watchdog 上限（毫秒）。 */
  timeoutMs: number
  /** HTTP 实现（测试注入桩；需响应 signal 中止）。 */
  fetchImpl?: FetchLike | undefined
  /** 输出预算（tokens，含推理）；默认 {@link DEFAULT_MAX_TOKENS}。 */
  maxTokens?: number | undefined
}

/** 模型响应里用到的字段。 */
interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null }
  }>
}

/**
 * 单次 chat 调用，返回非空 message.content。
 * @param deps - 端点、鉴权、模型、超时与输出预算。
 * @param args.system - system prompt。
 * @param args.user - user prompt。
 * @param args.jsonMode - true 时带 `response_format: json_object`。
 * @param args.label - 错误消息前缀（如 "LLM API" / "赛后总结 API"）。
 * @returns 非空的 content 文本。
 * @throws {@link ProviderError} 超时、非 200、空响应且重试仍失败时。
 */
export async function requestChatContent(
  deps: ChatCompletionDeps,
  args: { system: string; user: string; jsonMode: boolean; label: string },
): Promise<string> {
  const { system, user, jsonMode, label } = args
  let budget = deps.maxTokens ?? DEFAULT_MAX_TOKENS
  // 截断重试至多一次：budget < MAX_TOKENS_CAP 才允许进入下一轮
  for (;;) {
    const controller = new AbortController()
    const watchdog = setTimeout(() => {
      controller.abort()
    }, deps.timeoutMs)
    let response: ResponseLike
    try {
      response = await (deps.fetchImpl ?? fetch)(
        `${deps.baseURL.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({
            model: deps.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
            max_tokens: budget,
            stream: false,
          }),
          signal: controller.signal,
        },
      )
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderError(`${label}超时（${deps.timeoutMs}ms）`)
      }
      throw new ProviderError(`${label}请求失败：${String(error)}`)
    } finally {
      clearTimeout(watchdog)
    }
    if (!response.ok) {
      throw new ProviderError(
        `${label}返回 ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      )
    }
    const body = (await response.json()) as ChatCompletionResponse
    const choice = body.choices?.[0]
    const content = choice?.message?.content
    if (typeof content === 'string' && content.trim().length > 0) {
      return content
    }
    const finishReason = choice?.finish_reason ?? '未知'
    if (finishReason === 'length' && budget < MAX_TOKENS_CAP) {
      budget = Math.min(budget * 2, MAX_TOKENS_CAP)
      continue
    }
    if (finishReason === 'length') {
      throw new ProviderError(
        `${label}输出被 max_tokens=${budget} 截断（finish_reason=length）：模型推理过长，可增大 maxTokens 配置`,
      )
    }
    throw new ProviderError(`${label}响应缺少 choices[0].message.content（finish_reason=${finishReason}）`)
  }
}
