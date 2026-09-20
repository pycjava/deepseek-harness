/**
 * 赛后总结（复盘报告）生成。
 *
 * 与回合建议的区别：建议是"这一手怎么打"，总结是"整局打得怎么样"——
 * 因此这里是**一次自由文本调用**（不套 JSON 契约、不进发布契约），产出
 * 一份落盘的 Markdown 复盘档案，供页面展示与以后回看。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProviderError, requestChatContent, type ChatCompletionDeps } from '../advice/chatCompletion.ts'

/** 总结输入里的一条回合建议（来自重放档案）。 */
export interface ReviewTurn {
  turn: number
  kind: string
  headline: string
  why: string
  steps: string[]
  warning: string
  /** 该条建议的来源（llm / cache / rule / degraded）。 */
  source: string
}

/** 一次赛后总结的全部输入。 */
export interface ReviewInput {
  gameIndex: number
  /** 该局最大回合号。 */
  totalTurns: number
  /** 终局结果（win / loss / tie / unknown）。 */
  result: string
  friendlyName: string
  opponentName: string
  friendlyClass: string
  opponentClass: string
  /** 生成这些建议时使用的教练模式。 */
  coachMode: string
  /** 生成这些建议时使用的模型。 */
  model: string
  /** 逐回合建议（按回合升序）。 */
  turns: ReviewTurn[]
}

/** 总结生成器依赖（与建议 provider 同源的模型配置；超时可缺省，默认 30s）。 */
export type ReviewGeneratorOptions = Omit<ChatCompletionDeps, 'timeoutMs'> & {
  /** 看门狗上限（毫秒），默认 30s（总结比单回合建议长）。 */
  timeoutMs?: number | undefined
}

/**
 * 组装赛后总结的 prompt。
 * @param input - 整局建议流与对局元信息。
 * @returns system / user 两段文本。
 */
export function buildReviewPrompt(input: ReviewInput): { system: string; user: string } {
  const system =
    '你是一名炉石传说教练，正在为一局已经结束的对局写复盘报告。' +
    '报告用简体中文，只依据给出的对局与逐回合建议，不要编造未提供的信息（对手手牌始终不可见）。' +
    '结构固定为三节：## 关键回合（指出转折点与原因）、## 可以更好的地方（具体到回合与替代打法）、## 整体评价（一两句）。' +
    '直接输出 Markdown 正文，不要前后缀说明。'
  const lines = [
    `对局：第 ${input.gameIndex + 1} 局 · ${input.friendlyName || '我方'}（${input.friendlyClass}）vs ` +
      `${input.opponentName || '对手'}（${input.opponentClass}）`,
    `结果：${input.result} · 总回合数 ${input.totalTurns} · 教练模式 ${input.coachMode} · 模型 ${input.model}`,
    '',
    '逐回合建议（重放生成，按时间顺序）：',
  ]
  if (input.turns.length === 0) {
    lines.push('  （本次重放没有生成任何建议——可能全程处于快进区间）')
  }
  for (const turn of input.turns) {
    lines.push(`- 第 ${turn.turn} 回合 [${turn.kind}${turn.source === 'rule' ? ' · 规则判定' : ''}] ${turn.headline}`)
    if (turn.why) lines.push(`  理由：${turn.why}`)
    if (turn.steps.length > 0) lines.push(`  步骤：${turn.steps.join('；')}`)
    if (turn.warning) lines.push(`  风险：${turn.warning}`)
  }
  return { system, user: lines.join('\n') }
}

/** 赛后总结生成器：一次自由文本调用 + 落盘。 */
export class ReviewGenerator {
  private readonly timeoutMs: number

  /**
   * @param options - 模型配置与可选 fetch 注入。
   */
  constructor(private readonly options: ReviewGeneratorOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000
  }

  /**
   * 生成复盘正文（不落盘）。
   * @param input - 整局建议流与对局元信息。
   * @returns Markdown 复盘正文。
   */
  async generate(input: ReviewInput): Promise<string> {
    if (!this.options.apiKey) {
      throw new ProviderError('未配置 LLM API key（config.apiKey 或环境变量 DEEPSEEK_API_KEY）')
    }
    const { system, user } = buildReviewPrompt(input)
    const content = await requestChatContent(
      { ...this.options, timeoutMs: this.timeoutMs },
      { system, user, jsonMode: false, label: '赛后总结 API' },
    )
    return content.trim()
  }

  /**
   * 生成并写入复盘档案。
   * @param input - 整局建议流与对局元信息。
   * @param path - 目标 Markdown 路径（目录不存在时自动创建）。
   * @returns 写入的复盘正文。
   */
  async generateToFile(input: ReviewInput, path: string): Promise<string> {
    const text = await this.generate(input)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${text}\n`, 'utf-8')
    return text
  }
}
