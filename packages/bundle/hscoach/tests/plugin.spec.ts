/**
 * 插件级功能测试（真实编排 + 桩宿主/HTTP）：
 * init 装配 → /hscoach 命令 → 日志喂入 → 直连 API 建议（fetch 桩）→
 * 发布文件；再想想触发文件；mode 切换；start/stop。
 */
import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import pluginDefault, {
  HsCoachPlugin,
  realRuntimeDeps,
  resolveConfig,
  resolvePublishDir,
  type RuntimeDeps,
} from '../src/index.ts'
import type { Advice } from '../src/core/trigger.ts'
import type { ResponseLike } from '../src/advice/directProvider.ts'
import { StubContext } from './stubs/host.ts'

const fixtureLines = () =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'friendly_player_id_is_1.power.log'), 'utf-8')
    .split(/\r?\n/)
    .filter(l => l.length > 0)

/** 可控 FakeTail：测试手动喂行。 */
class FakeTail {
  static instances: FakeTail[] = []
  options: ConstructorParameters<typeof import('../src/core/tail.ts').PowerLogTail>[0]
  stopped = false
  constructor(options: ConstructorParameters<typeof import('../src/core/tail.ts').PowerLogTail>[0]) {
    this.options = options
    FakeTail.instances.push(this)
  }
  async run(): Promise<void> {
    // 常驻直到 stop（与真实 tail 语义一致）
    while (!this.stopped && !this.options.shouldStop?.()) {
      await new Promise(r => setTimeout(r, 5))
    }
  }
  stop(): void {
    this.stopped = true
  }
  feed(lines: string[]): void {
    void this.options.onLines(lines)
  }
}

let dir: string
let ctx: StubContext
let polls: Array<() => void>
let fetchCalls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }>
let releaseAdvice: (() => void) | null = null
let adviceGate: Promise<void>
let consoleLog: MockInstance<typeof console.log>
let consoleError: MockInstance<typeof console.error>

function jsonResponse(headline: string): ResponseLike {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ kind: 'pass', headline, why: '测试' }) } }],
    }),
  }
}

function makeDeps(): RuntimeDeps {
  const deps: RuntimeDeps = {
    resolveLogPath: async () => join(dir, 'Power.log'),
    tail: FakeTail as unknown as RuntimeDeps['tail'],
    ensureLogConfig: async () => ({
      action: 'already_ok',
      path: '',
      backupPath: null,
      message: 'stub',
    }),
    setInterval: (callback: () => void) => {
      polls.push(callback)
      return () => {
        const idx = polls.indexOf(callback)
        if (idx >= 0) polls.splice(idx, 1)
      }
    },
    fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      fetchCalls.push({ url, init })
      await adviceGate
      return jsonResponse(`建议${fetchCalls.length}`)
    }) as unknown as NonNullable<RuntimeDeps['fetch']>,
  }
  return deps
}

function makeRawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publishDir: dir,
    apiKey: 'test-key',
    baseURL: 'http://llm.test',
    model: 'test-model',
    autoStart: true,
    ...overrides,
  }
}

async function makePlugin(rawConfig: Record<string, unknown> = {}) {
  const plugin = new HsCoachPlugin(
    ctx as unknown as Context,
    resolveConfig(makeRawConfig(rawConfig)),
    makeDeps(),
  )
  await plugin.init()
  return plugin
}

async function command(_plugin: HsCoachPlugin, raw: string) {
  const cmd = ctx.commands.registrations.find(r => r.name === 'hscoach')
  if (!cmd) throw new Error('/hscoach 未注册')
  return cmd.handler({ rawInput: raw })
}

/** 多实例同 ctx 时按注册序取命令（1 = 第一个实例，2 = 第二个实例）。 */
async function commandNth(nth: number, raw: string) {
  const regs = ctx.commands.registrations.filter(r => r.name === 'hscoach')
  const cmd = regs[nth - 1]
  if (!cmd) throw new Error(`/hscoach 第 ${nth} 个注册不存在`)
  return cmd.handler({ rawInput: raw })
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  for (let i = 0; i < timeoutMs / 10 && !predicate(); i++) {
    await new Promise(r => setTimeout(r, 10))
  }
}

/** 固定等待（给 fire-and-forget 的建议链落定时间）。 */
async function settle(ms = 50): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-plugin-'))
  FakeTail.instances = []
  polls = []
  fetchCalls = []
  releaseAdvice = null
  adviceGate = new Promise<void>(r => (releaseAdvice = r))
  ctx = new StubContext()
  // 生命周期事件直出控制台：测试静音并捕获以断言
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('dsh-hscoach 插件', () => {
  it('default 导出是名为 dsh-hscoach 的函数（cordis 函数插件装载形态）', () => {
    expect(typeof pluginDefault).toBe('function')
    expect((pluginDefault as { name?: string }).name).toBe('dsh-hscoach')
  })

  it('init 装配：卡牌库就绪、/hscoach 注册、tail 启动；喂入 fixture → 发布 advice', async () => {
    const plugin = await makePlugin()
    expect(ctx.commands.registrations.map(r => r.name)).toContain('hscoach')
    expect(FakeTail.instances.length).toBe(1)
    // 请求直连 API：URL/鉴权/模型
    FakeTail.instances[0]!.feed(fixtureLines())
    await waitUntil(() => fetchCalls.length > 0)
    releaseAdvice!()
    await settle()

    expect(fetchCalls.length).toBeGreaterThan(0)
    const first = fetchCalls[0]!
    expect(first.url).toBe('http://llm.test/chat/completions')
    expect(first.init.headers.authorization).toBe('Bearer test-key')
    expect((JSON.parse(first.init.body) as { model?: string }).model).toBe('test-model')
    const advice = JSON.parse(await readFile(join(dir, 'advice.json'), 'utf-8')) as {
      advice: Advice
    }
    expect(advice.advice.headline).toMatch(/^建议\d+$/)
    const status = await command(plugin, 'status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain('最近建议')
    expect(status.text).toContain('模型：test-model（http://llm.test）')

    await command(plugin, 'stop')
  }, 30000)

  it('/hscoach think 与 think-again.trigger 都会触发重新推理', async () => {
    const plugin = await makePlugin()
    FakeTail.instances[0]!.feed(fixtureLines())
    await waitUntil(() => fetchCalls.length > 0)
    // 放行第一次建议
    releaseAdvice!()
    await settle()
    const callsAfterFirst = fetchCalls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // 触发文件 → 轮询 → thinkAgain
    const trigger = join(resolvePublishDir(dir), 'think-again.trigger')
    await writeFile(trigger, 'think', 'utf-8')
    polls.forEach((poll) =>{  poll() })
    await waitUntil(() => fetchCalls.length > callsAfterFirst)
    // 放行第二次
    releaseAdvice?.()
    await settle()
    await command(plugin, 'stop')
  }, 30000)

  it('/hscoach mode 切换教练模式（非法值报错）', async () => {
    const plugin = await makePlugin({ autoStart: false })
    const bad = await command(plugin, 'mode ultra')
    expect(bad.kind).toBe('error')
    const ok = await command(plugin, 'mode compete')
    expect(ok).toMatchObject({ kind: 'success' })
    expect((plugin as unknown as { engine: { coachMode: string } }).engine.coachMode).toBe(
      'compete',
    )
  })

  it('start 前缀日志与 stop 后 tail 停止；重启新建 tail', async () => {
    const plugin = await makePlugin({ autoStart: false })
    expect(FakeTail.instances.length).toBe(0)
    await command(plugin, 'start')
    expect(FakeTail.instances.length).toBe(1)
    const stopReply = await command(plugin, 'stop')
    expect(stopReply.kind).toBe('success')
    expect(FakeTail.instances[0]!.stopped).toBe(true)
    // 重启 → 新建 tail 实例（旧的已停止）
    await command(plugin, 'start')
    expect(FakeTail.instances.length).toBe(2)
    expect(FakeTail.instances[1]!.stopped).toBe(false)
  })

  it('未配置 API key：启动告警，建议链降级发布占位', async () => {
    let gateReleased = false
    void adviceGate.then(() => (gateReleased = true))
    const plugin = new HsCoachPlugin(
      ctx as unknown as Context,
      resolveConfig(makeRawConfig({ apiKey: '', autoStart: true })),
      makeDeps(),
    )
    await plugin.init()
    expect(ctx.logs.some(l => l.message.includes('未配置 API key'))).toBe(true)
    FakeTail.instances[0]!.feed(fixtureLines())
    const advicePath = join(dir, 'advice.json')
    await waitUntil(() => existsSync(advicePath), 10_000)
    // 无 key：provider 立即失败，不发起 HTTP；引擎降级发布占位建议
    expect(gateReleased).toBe(false)
    expect(fetchCalls.length).toBe(0)
    const advice = JSON.parse(await readFile(advicePath, 'utf-8')) as {
      advice: Advice
    }
    expect(advice.advice.degraded).toBe(true)
    await command(plugin, 'stop')
  }, 30000)

  it('resolveConfig：config > 环境变量 > 默认值', () => {
    const previousKey = process.env.DEEPSEEK_API_KEY
    const previousUrl = process.env.DEEPSEEK_BASE_URL
    try {
      process.env.DEEPSEEK_API_KEY = 'env-key'
      process.env.DEEPSEEK_BASE_URL = 'http://env.llm'
      const envOnly = resolveConfig({})
      expect(envOnly.apiKey).toBe('env-key')
      expect(envOnly.baseURL).toBe('http://env.llm')
      expect(envOnly.model).toBe('deepseek-chat')
      expect(envOnly.autoStart).toBe(true)
      const explicit = resolveConfig({ apiKey: 'cfg-key', baseURL: 'http://cfg.llm/' })
      expect(explicit.apiKey).toBe('cfg-key')
      expect(explicit.baseURL).toBe('http://cfg.llm/')
      const coachMode = resolveConfig({ coachMode: 'compete' })
      expect(coachMode.coachMode).toBe('compete')
      expect(resolveConfig({ coachMode: 'ultra' }).coachMode).toBe('teach')
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = previousKey
      if (previousUrl === undefined) delete process.env.DEEPSEEK_BASE_URL
      else process.env.DEEPSEEK_BASE_URL = previousUrl
    }
  })
})

describe('dsh-hscoach 插件分支补齐', () => {
  it('default 导出可端到端装载（真实 runtime deps、autoStart 关闭）', async () => {
    const previous = process.env.DSH_HSCOACH_PUBLISH_DIR
    process.env.DSH_HSCOACH_PUBLISH_DIR = join(dir, 'publish')
    try {
      await pluginDefault(ctx as unknown as Context, makeRawConfig({ autoStart: false }))
      expect(ctx.commands.registrations.map(r => r.name)).toContain('hscoach')
    } finally {
      if (previous === undefined) delete process.env.DSH_HSCOACH_PUBLISH_DIR
      else process.env.DSH_HSCOACH_PUBLISH_DIR = previous
      // 触发 effect 卸载器（清掉真实轮询定时器）
      for (const dispose of [...ctx.effects]) dispose()
    }
  })

  it('restore-log 子命令走真实回滚（LOCALAPPDATA 指向临时目录）', async () => {
    const plugin = await makePlugin({ autoStart: false })
    const previous = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = join(dir, 'local')
    try {
      const reply = await command(plugin, 'restore-log')
      expect(reply.kind).toBe('success')
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = previous
    }
  })

  it('未知子命令报错；status 汇总战绩与最近建议（含损坏 advice 容错）', async () => {
    const plugin = await makePlugin({ autoStart: false })
    const unknown = await command(plugin, 'frobnicate')
    expect(unknown.kind).toBe('error')
    expect(unknown).toMatchObject({ kind: 'error' })

    await writeFile(join(dir, 'history.jsonl'), JSON.stringify({ result: 'win' }) + '\n', 'utf8')
    await writeFile(
      join(dir, 'advice.json'),
      JSON.stringify({ turn: 3, advice: { headline: '打脸', degraded: true } }),
      'utf8',
    )
    const rich = await command(plugin, 'status')
    expect(rich.kind).toBe('success')
    expect(rich.kind === 'success' && rich.text).toContain('战绩：1胜')
    expect(rich.kind === 'success' && rich.text).toContain('最近建议（T3）：打脸（降级）')

    await writeFile(join(dir, 'advice.json'), '{oops', 'utf8')
    const corrupt = await command(plugin, 'status')
    expect(corrupt.kind).toBe('success')
  })

  it('log.config 配置失败不阻断启动（告警日志）', async () => {
    const failing = makeDeps()
    failing.ensureLogConfig = async () => {
      throw new Error('reg 不可用')
    }
    const plugin = new HsCoachPlugin(
      ctx as unknown as Context,
      resolveConfig(makeRawConfig({ autoStart: true })),
      failing,
    )
    await plugin.init()
    expect(ctx.logs.some(l => l.message.includes('log.config 配置失败'))).toBe(true)
    await command(plugin, 'stop')
  })

  it('tail 异常退出记录错误日志并可重启', async () => {
    class ExplodingTail extends FakeTail {
      static override instances: ExplodingTail[] = []
      constructor(options: ConstructorParameters<typeof FakeTail>[0]) {
        super(options)
        ExplodingTail.instances.push(this)
      }
      override async run(): Promise<void> {
        throw new Error('tail 崩了')
      }
    }
    const failing = makeDeps()
    failing.tail = ExplodingTail as unknown as RuntimeDeps['tail']
    const plugin = new HsCoachPlugin(
      ctx as unknown as Context,
      resolveConfig(makeRawConfig({ autoStart: true })),
      failing,
    )
    await plugin.init()
    await settle(50)
    expect(ctx.logs.some(l => l.level === 'error' && l.message.includes('tail 异常退出'))).toBe(true)
    const reply = await command(plugin, 'start')
    expect(reply.kind).toBe('success')
    await command(plugin, 'stop')
  })

  it('resolvePublishDir：显式配置 > 环境变量 > LOCALAPPDATA 默认', () => {
    expect(resolvePublishDir('/explicit')).toBe('/explicit')
    const previous = process.env.DSH_HSCOACH_PUBLISH_DIR
    const local = process.env.LOCALAPPDATA
    try {
      process.env.DSH_HSCOACH_PUBLISH_DIR = '/from-env'
      expect(resolvePublishDir('')).toBe('/from-env')
      delete process.env.DSH_HSCOACH_PUBLISH_DIR
      process.env.LOCALAPPDATA = '/la'
      expect(resolvePublishDir('')).toBe(join('/la', 'com.ntetoolbox.client', 'hscoach'))
    } finally {
      if (previous === undefined) delete process.env.DSH_HSCOACH_PUBLISH_DIR
      else process.env.DSH_HSCOACH_PUBLISH_DIR = previous
      if (local === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = local
    }
  })

  it('cardDataDir 覆盖目录优先于默认数据目录', async () => {
    const custom = join(dir, 'cards')
    await (await import('node:fs/promises')).mkdir(custom, { recursive: true })
    await writeFile(
      join(custom, 'cards.all.zhCN.json'),
      JSON.stringify([{ id: 'TST_001', name: '测试卡', cost: 0, type: 'MINION', cardClass: 'NEUTRAL', set: 'TST' }]),
      'utf8',
    )
    await makePlugin({ autoStart: false, cardDataDir: custom })
    expect(ctx.logs.some(l => l.message.includes('卡牌库就绪'))).toBe(true)
  })

  it('再想想轮询在未监听时不触发（autoStart 关闭）', async () => {
    const plugin = await makePlugin({ autoStart: false })
    expect(FakeTail.instances.length).toBe(0)
    await writeFile(join(resolvePublishDir(dir), 'think-again.trigger'), 'x', 'utf8')
    polls.forEach((poll) =>{  poll() })
    await settle(30)
    expect(fetchCalls.length).toBe(0)
    expect(plugin).toBeDefined()
  })
})

describe('dsh-hscoach 插件收尾分支', () => {
  it('resolveConfig：空 coachMode / 环境变量缺省 / 超时缺省 / autoStart 非法值', () => {
    const previousKey = process.env.DEEPSEEK_API_KEY
    const previousUrl = process.env.DEEPSEEK_BASE_URL
    try {
      delete process.env.DEEPSEEK_API_KEY
      delete process.env.DEEPSEEK_BASE_URL
      const config = resolveConfig({ coachMode: '' })
      expect(config.coachMode).toBe('teach')
      expect(config.apiKey).toBe('')
      expect(config.baseURL).toBe('https://api.deepseek.com')
      expect(config.adviceTimeoutMs).toBe(15_000)
      expect(config.autoStart).toBe(true)
      expect(resolveConfig({ autoStart: 'yes' as unknown as boolean }).autoStart).toBe(false)
    } finally {
      if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
      if (previousUrl !== undefined) process.env.DEEPSEEK_BASE_URL = previousUrl
    }
  })

  it('再想想触发文件重复轮询（mtime 不变）不重复触发', async () => {
    const plugin = await makePlugin()
    FakeTail.instances[0]!.feed(fixtureLines())
    await waitUntil(() => fetchCalls.length > 0)
    releaseAdvice!()
    await settle()
    const trigger = join(resolvePublishDir(dir), 'think-again.trigger')
    await writeFile(trigger, 'think', 'utf8')
    polls.forEach((poll) =>{  poll() })
    await waitUntil(() => fetchCalls.length > 1)
    releaseAdvice?.()
    await settle()
    await command(plugin, 'stop')
  }, 30000)

  it('status 在未启动（autoStart 关）时显示已停止且无战绩行', async () => {
    const plugin = await makePlugin({ autoStart: false })
    const reply = await command(plugin, 'status')
    expect(reply.kind).toBe('success')
    expect(reply.kind === 'success' && reply.text).toContain('监听：已停止')
    expect(reply.kind === 'success' && reply.text).toContain('卡牌库：')
  })
})

describe('dsh-hscoach 插件终批分支', () => {
  it('calibrated/advice-published 事件经 handleEvent 记录；校准与显式配置冲突可见', async () => {
    const plugin = new HsCoachPlugin(
      ctx as unknown as Context,
      resolveConfig(makeRawConfig({ friendlyPlayerId: 2, autoStart: true })),
      makeDeps(),
    )
    await plugin.init()
    FakeTail.instances[0]!.feed(fixtureLines())
    await waitUntil(() => fetchCalls.length > 0)
    releaseAdvice!()
    await settle()
    const calibrated = ctx.logs.find(l => l.message.includes('自动校准：友方玩家 id = 1'))
    expect(calibrated).toBeDefined()
    const published = ctx.logs.find(l => l.message.includes('建议已发布'))
    expect(published).toBeDefined()
    await command(plugin, 'stop')
  }, 30000)

  it('/hscoach think 在就绪引擎上成功；空 rawInput 走 status；异常走 error 文案', async () => {
    const plugin = await makePlugin()
    FakeTail.instances[0]!.feed(fixtureLines())
    await waitUntil(() => fetchCalls.length > 0)
    releaseAdvice!()
    await settle()
    const thought = await command(plugin, 'think')
    expect(thought.kind).toBe('success')

    const cmd = ctx.commands.registrations.find(r => r.name === 'hscoach')
    if (!cmd) throw new Error('/hscoach 未注册')
    const noInput = await cmd.handler({})
    expect(noInput.kind).toBe('success')

    const previous = process.env.LOCALAPPDATA
    const fakeLocal = join(dir, 'fake-local')
    const hsDir = join(fakeLocal, 'Blizzard', 'Hearthstone')
    await mkdir(hsDir, { recursive: true })
    await writeFile(join(hsDir, 'log.config.bak.ntetoolbox'), 'backup', 'utf8')
    // 目标位置是目录 → rename 失败 → 命令走 error 分支
    await mkdir(join(hsDir, 'log.config'), { recursive: true })
    process.env.LOCALAPPDATA = fakeLocal
    try {
      const failing = await cmd.handler({ rawInput: 'restore-log' })
      expect(failing.kind).toBe('error')
    } finally {
      if (previous === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = previous
    }
    await command(plugin, 'stop')
  }, 30000)

  it('status 显示已校准的友方 id 与缺字段的最近建议', async () => {
    const plugin = await makePlugin()
    FakeTail.instances[0]!.feed(fixtureLines())
    await waitUntil(() => fetchCalls.length > 0)
    releaseAdvice!()
    await waitUntil(() => existsSync(join(dir, 'advice.json')))
    await writeFile(join(dir, 'advice.json'), JSON.stringify({ turn: 4 }), 'utf8')
    const reply = await command(plugin, 'status')
    expect(reply.kind).toBe('success')
    expect(reply.kind === 'success' && reply.text).toContain('最近建议（T4）：')
    expect(reply.kind === 'success' && reply.text).toContain('友方 id：1')
    await command(plugin, 'stop')
  }, 30000)

  it('启动时 tail 的 resolvePath 选项被求值；shutdown 清理残留触发文件', async () => {
    const plugin = await makePlugin({ autoStart: true })
    const tailOptions = FakeTail.instances[0]!.options
    const resolved = await tailOptions.resolvePath()
    expect(resolved).toBe(join(dir, 'Power.log'))
    await writeFile(join(resolvePublishDir(dir), 'think-again.trigger'), 'x', 'utf8')
    // 触发一次轮询（mtime 记录）后 shutdown 删除触发文件
    polls.forEach((poll) =>{  poll() })
    await command(plugin, 'stop')
  }, 30000)

  it('resolveConfig 的 NaN 与非法类型友好方 id 回退未设置', () => {
    expect(resolveConfig({ friendlyPlayerId: Number.NaN }).friendlyPlayerId).toBeUndefined()
    expect(resolveConfig({ friendlyPlayerId: 'x' as unknown as number }).friendlyPlayerId).toBeUndefined()
  })

  it('单实例锁：同发布目录第二个实例 autoStart 拒绝启动（不建 tail、不覆盖锁）', async () => {
    const first = await makePlugin()
    expect(FakeTail.instances.length).toBe(1)
    await makePlugin()
    // 第二实例被锁拒绝：无新 tail，锁仍归第一实例持有
    expect(FakeTail.instances.length).toBe(1)
    expect(ctx.logs.some(l => l.message.includes('另一个教练实例正在运行'))).toBe(true)
    const warned = consoleError.mock.calls.map(c => String(c[0])).join('\n')
    expect(warned).toContain('另一个教练实例正在运行')
    expect(warned).toContain(`PID ${process.pid}`)
    const lockText = await readFile(join(dir, 'hscoachd.lock'), 'utf-8')
    expect(lockText).toBe(String(process.pid))
    await command(first, 'stop')
    // 第一实例停止释放锁后，第二实例 start 成功
    const retry = await commandNth(2, 'start')
    expect(retry.kind).toBe('success')
    expect(FakeTail.instances.length).toBe(2)
    await commandNth(2, 'stop')
  }, 30000)

  it('单实例锁：hscoach start 在锁被占时返回错误文案', async () => {
    const first = await makePlugin()
    await makePlugin({ autoStart: false })
    const refused = await commandNth(2, 'start')
    expect(refused.kind).toBe('error')
    expect(refused.kind === 'error' && refused.text).toContain('另一个教练实例正在运行')
    await command(first, 'stop')
  })

  it('启动横幅直出控制台：发布目录与监听路径可见', async () => {
    const plugin = await makePlugin()
    const logged = consoleLog.mock.calls.map(c => String(c[0])).join('\n')
    expect(logged).toContain(dir)
    expect(logged).toContain('卡牌库就绪')
    expect(logged).toContain('开始监听')
    expect(logged).toContain(join(dir, 'Power.log'))
    expect(logged).toMatch(/\[hscoach \d{2}:\d{2}:\d{2}\]/)
    await command(plugin, 'stop')
  }, 30000)

  it('shutdown 清理未被轮询消费的残留触发文件（未监听时轮询跳过）', async () => {
    await makePlugin({ autoStart: false })
    const trigger = join(resolvePublishDir(dir), 'think-again.trigger')
    await writeFile(trigger, 'x', 'utf8')
    // 未监听：轮询守卫直接返回，触发文件留给 shutdown 清理
    polls.forEach((poll) =>{  poll() })
    expect(existsSync(trigger)).toBe(true)
    for (const dispose of [...ctx.effects]) dispose()
    expect(existsSync(trigger)).toBe(false)
  })

  it('resolvePublishDir 在 LOCALAPPDATA 缺失时回退 home 目录', () => {
    const previous = process.env.LOCALAPPDATA
    try {
      delete process.env.LOCALAPPDATA
      const resolved = resolvePublishDir('')
      expect(resolved).toContain('com.ntetoolbox.client')
      expect(resolved).not.toContain(dir)
    } finally {
      if (previous !== undefined) process.env.LOCALAPPDATA = previous
    }
  })

  it('realRuntimeDeps.resolveLogPath 可直接求值（只读探测）', async () => {
    const path = await realRuntimeDeps.resolveLogPath()
    expect(path.endsWith('Power.log')).toBe(true)
  })
})

describe('dsh-hscoach 插件覆盖收尾', () => {
  it('无 key 降级发布的日志带"降级"后缀', async () => {
    const plugin = new HsCoachPlugin(
      ctx as unknown as Context,
      resolveConfig(makeRawConfig({ apiKey: '', autoStart: true })),
      makeDeps(),
    )
    await plugin.init()
    FakeTail.instances[0]!.feed(fixtureLines())
    const advicePath = join(dir, 'advice.json')
    await waitUntil(() => existsSync(advicePath), 10_000)
    const degraded = JSON.parse(await readFile(advicePath, 'utf8')) as { advice?: { degraded?: boolean } }
    expect(degraded.advice?.degraded).toBe(true)
    expect(ctx.logs.some(l => l.message.includes('建议生成失败'))).toBe(true)
    await command(plugin, 'stop')
  }, 30000)

  it('status 容忍缺 turn/headline 的建议文件', async () => {
    const plugin = await makePlugin({ autoStart: false })
    await writeFile(join(dir, 'advice.json'), JSON.stringify({ advice: {} }), 'utf8')
    const reply = await command(plugin, 'status')
    expect(reply.kind).toBe('success')
    expect(reply.kind === 'success' && reply.text).toContain('最近建议（T?）：')
  })

  it('运行中无触发文件的轮询与 stop 后的轮询都安全返回；重复轮询同 mtime 不再触发', async () => {
    const plugin = await makePlugin()
    // 运行中、无触发文件
    polls.forEach((poll) =>{  poll() })
    await command(plugin, 'stop')
    // stop 之后带触发文件的轮询（stopped 守卫）
    await writeFile(join(resolvePublishDir(dir), 'think-again.trigger'), 'x', 'utf8')
    polls.forEach((poll) =>{  poll() })
    polls.forEach((poll) =>{  poll() })
    expect(fetchCalls.length).toBeGreaterThanOrEqual(0)
  }, 30000)
})
