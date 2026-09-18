/**
 * 卡牌知识库：内置 HearthstoneJSON 简中卡库
 * （cards.all.zhCN.json 全卡 + cards.zhCN.json 收集卡，收集卡优先覆盖）。
 * 查询纯内存、离线可用，无下载路径。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG_RE = /<\/?[bi]>/g
const PLACEHOLDER_RE = /\{\d+\}/g
const WHITESPACE_RE = /\n{3,}/g

/**
 * HearthstoneJSON 文本标记清洗（<b>/<i>/$/#/[x]/{N}）。
 * @param raw - 卡牌原始文本；null/undefined/空串返回空串。
 * @returns 清洗并裁剪首尾空白后的卡牌文本。
 */
export function cleanText(raw: string | null | undefined): string {
  if (!raw) return ''
  const text = raw
    .replace(TAG_RE, '')
    .replace(/\$/g, '\n')
    .replace(/#/g, '• ')
    .replace(/\[x\]/g, '')
    .replace(PLACEHOLDER_RE, 'X')
    .replace(WHITESPACE_RE, '\n\n')
  return text.trim()
}

/** 归一化后的卡牌静态数据（由 HearthstoneJSON 原始条目加载而来）。 */
export interface Card {
  id: string
  name: string
  text: string
  cost: number
  attack: number | null
  health: number | null
  type: string
  cardClass: string
  cardSet: string
}

interface RawCard {
  id?: string
  name?: string
  text?: string
  cost?: number
  attack?: number
  health?: number
  type?: string
  cardClass?: string
  set?: string
}

/**
 * 卡库数据目录：随插件分发的 data/（HearthstoneJSON 简中全卡 + 收集卡）。
 * @param moduleUrl - 卡牌模块的 import.meta.url。
 * @returns 候选数据目录路径列表（源码 src/core/ 上跳两级到包根，打包后的
 * lib/index.js 上跳一级；按存在性依次尝试）。
 */
export function dataDirsFor(moduleUrl: string): string[] {
  const pkgDir = dirname(fileURLToPath(moduleUrl)) // …/src/core 或 …/lib
  return [join(resolve(pkgDir, '..', '..'), 'data'), join(resolve(pkgDir, '..'), 'data')]
}

/** 默认数据目录候选：以本模块位置调用 {@link dataDirsFor}。
 * @returns 候选数据目录路径列表。
 */
export function defaultDataDirs(): string[] {
  return dataDirsFor(import.meta.url)
}

/** 内存卡牌知识库：加载 HearthstoneJSON 数据文件并提供按 id 查询。 */
export class CardDatabase {
  private cards = new Map<string, Card>()
  private loaded = false

  constructor(private readonly dataDirs: string[] = defaultDataDirs()) {}

  /** 已加载的卡牌条目数。 */
  get size(): number {
    return this.cards.size
  }

  /**
   * 从数据目录加载卡库（重复调用幂等）。
   * @returns 加载完成后 resolve；必需数据文件缺失时 reject。
   */
  async build(): Promise<void> {
    if (this.loaded) return
    const all = await this.readJson('cards.all.zhCN.json', true)
    const collectible = await this.readJson('cards.zhCN.json', false)
    const map = new Map<string, Card>()
    // 全卡先装（含教程卡），收集卡覆盖
    for (const entry of all) loadEntry(map, entry)
    for (const entry of collectible) loadEntry(map, entry)
    this.cards = map
    this.loaded = true
  }

  private async readJson(filename: string, required: boolean): Promise<RawCard[]> {
    for (const dir of this.dataDirs) {
      const path = join(dir, filename)
      if (!existsSync(path)) continue
      try {
        const raw = JSON.parse(await readFile(path, 'utf-8')) as RawCard[]
        if (Array.isArray(raw)) return raw
      } catch {
        // 损坏文件按缺失处理，继续找下一个候选目录
      }
    }
    if (required) throw new Error(`card database not found: ${filename}`)
    return []
  }

  /**
   * 按卡牌 id 查询。
   * @param cardId - HearthstoneJSON 卡牌 id。
   * @returns 命中的卡牌数据；未加载到该 id 时为 undefined。
   */
  get(cardId: string): Card | undefined {
    return this.cards.get(cardId)
  }

  /**
   * 列出全部已加载卡牌。
   * @returns 卡牌数据的数组副本。
   */
  iterCards(): Card[] {
    return [...this.cards.values()]
  }

  /**
   * 判断卡库是否包含指定卡牌。
   * @param cardId - HearthstoneJSON 卡牌 id。
   * @returns 包含返回 true。
   */
  has(cardId: string): boolean {
    return this.cards.has(cardId)
  }
}

function loadEntry(map: Map<string, Card>, entry: RawCard): void {
  const id = entry.id
  if (!id) return
  map.set(id, {
    id,
    name: entry.name ?? id,
    text: cleanText(entry.text),
    cost: entry.cost ?? 0,
    attack: entry.attack ?? null,
    health: entry.health ?? null,
    type: entry.type ?? '',
    cardClass: entry.cardClass ?? '',
    cardSet: entry.set ?? '',
  })
}
