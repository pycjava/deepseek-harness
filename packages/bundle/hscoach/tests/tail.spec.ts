/**
 * Power.log tail 单元测试：末尾起尾随/首现从头读/增量/半行缓冲/
 * 路径切换与轮换（大小倒退）、停止语义。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { PowerLogTail } from '../src/core/tail.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-tail-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

interface TailHarness {
  tail: PowerLogTail
  run: Promise<void>
  batches: string[][]
  flat: () => string[]
}

/** 组装 tail：微延迟轮询（让并发文件写入有机会插入），收齐期望行即停。 */
function makeTail(options: {
  nextPath: () => string
  until?: (flat: string[]) => boolean
  maxTicks?: number
  onLinesReturn?: () => false | undefined
}): TailHarness {
  const batches: string[][] = []
  let ticks = 0
  const maxTicks = options.maxTicks ?? 400
  const flat = () => batches.flat()
  const tail = new PowerLogTail({
    resolvePath: async () => options.nextPath(),
    pollIntervalMs: 1,
    onLines: (lines) => {
      batches.push(lines)
      return options.onLinesReturn?.()
    },
    shouldStop: () => ticks >= maxTicks || (options.until?.(flat()) ?? false),
    sleep: async () => {
      ticks += 1
      await delay(2)
    },
  })
  return { tail, run: tail.run(), batches, flat }
}

describe('PowerLogTail', () => {
  it('启动时已存在的文件从末尾尾随（不重放历史）', async () => {
    const path = join(dir, 'Power.log')
    await writeFile(path, 'D 09:00:00.000 old line 1\nD 09:00:01.000 old line 2\n', 'utf8')
    const harness = makeTail({ nextPath: () => path, maxTicks: 20 })
    await harness.run
    expect(harness.batches).toEqual([])
  }, 10_000)

  it('文件首现时从头读（含全部内容）', async () => {
    const path = join(dir, 'Power.log')
    void (async () => {
      await delay(6)
      await writeFile(path, 'D 09:00:00.000 first\nD 09:00:01.000 second\n', 'utf8')
    })()
    const harness = makeTail({
      nextPath: () => path,
      until: flat => flat.includes('D 09:00:01.000 second'),
    })
    await harness.run
    expect(harness.flat()).toEqual(['D 09:00:00.000 first', 'D 09:00:01.000 second'])
  }, 10_000)

  it('增量追加分批送达；半行缓冲到换行才发', async () => {
    const path = join(dir, 'Power.log')
    await writeFile(path, '', 'utf8')
    void (async () => {
      await delay(6)
      await writeFile(path, 'D 09:00:00.000 whole\nD 09:00:01.000 partial', 'utf8')
      await delay(30)
      await writeFile(path, 'D 09:00:00.000 whole\nD 09:00:01.000 partial end\n', 'utf8')
    })()
    const harness = makeTail({
      nextPath: () => path,
      until: flat => flat.includes('D 09:00:01.000 partial end') && !flat.includes('D 09:00:01.000 partial'),
    })
    await harness.run
    const flat = harness.flat()
    expect(flat).toContain('D 09:00:00.000 whole')
    expect(flat).toContain('D 09:00:01.000 partial end')
    expect(flat).not.toContain('D 09:00:01.000 partial')
  }, 10_000)

  it('路径切换（国服新时间戳目录）→ 新文件从头读', async () => {
    const first = join(dir, 'one')
    const second = join(dir, 'two')
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(join(first, 'Power.log'), 'D 09:00:00.000 from-one\n', 'utf8')
    let phase = 0
    const harness = makeTail({
      nextPath: () => {
        phase += 1
        return phase <= 2 ? join(second, 'Power.log') : join(first, 'Power.log')
      },
      until: flat => flat.some(l => l.includes('from-one')),
      maxTicks: 60,
    })
    await harness.run
    expect(harness.flat().some(l => l.includes('from-one'))).toBe(true)
  }, 10_000)

  it('路径切换到更新的现存文件 → 从头读（新对局目录）', async () => {
    const stale = join(dir, 'z-stale', 'Power.log')
    const fresh = join(dir, 'a-fresh', 'Power.log')
    await mkdir(join(dir, 'z-stale'), { recursive: true })
    await mkdir(join(dir, 'a-fresh'), { recursive: true })
    await writeFile(stale, 'D 08:00:00.000 stale-game\n', 'utf8')
    let switched = false
    const harness = makeTail({
      nextPath: () => (switched ? fresh : stale),
      until: flat => flat.some(l => l.includes('new-game')),
      maxTicks: 60,
    })
    void (async () => {
      // 新对局目录在监听开始后出现（创建时间更晚）
      await delay(8)
      await writeFile(fresh, 'D 09:00:00.000 new-game\n', 'utf8')
      switched = true
    })()
    await harness.run
    expect(harness.flat().some(l => l.includes('new-game'))).toBe(true)
  }, 10_000)

  it('路径回退到更旧的现存文件 → 从末尾续读，不重放旧对局', async () => {
    const stale = join(dir, 'z-stale', 'Power.log')
    const fresh = join(dir, 'a-fresh', 'Power.log')
    await mkdir(join(dir, 'z-stale'), { recursive: true })
    await mkdir(join(dir, 'a-fresh'), { recursive: true })
    await writeFile(stale, 'D 08:00:00.000 stale-game\n', 'utf8')
    await delay(20)
    await writeFile(fresh, 'D 09:00:00.000 live-game\n', 'utf8')
    let fallback = false
    const harness = makeTail({
      nextPath: () => (fallback ? stale : fresh),
      maxTicks: 50,
    })
    void (async () => {
      await delay(15)
      fallback = true
    })()
    await harness.run
    expect(harness.flat().some(l => l.includes('stale-game'))).toBe(false)
  }, 10_000)

  it('缺失窗口后回退到更旧的文件 → 从末尾续读（监听目录被清理）', async () => {
    const stale = join(dir, 'z-stale', 'Power.log')
    const fresh = join(dir, 'a-fresh', 'Power.log')
    const missing = join(dir, 'gone', 'Power.log')
    await mkdir(join(dir, 'z-stale'), { recursive: true })
    await mkdir(join(dir, 'a-fresh'), { recursive: true })
    await writeFile(stale, 'D 08:00:00.000 stale-game\n', 'utf8')
    await delay(20)
    await writeFile(fresh, 'D 09:00:00.000 live-game\n', 'utf8')
    let stage = 0
    const harness = makeTail({
      nextPath: () => (stage === 0 ? fresh : stage === 1 ? missing : stale),
      maxTicks: 80,
    })
    void (async () => {
      await delay(10)
      stage = 1
      await rm(fresh, { force: true })
      await delay(30)
      stage = 2
    })()
    await harness.run
    expect(harness.flat().some(l => l.includes('stale-game'))).toBe(false)
  }, 10_000)

  it('大小倒退（轮换）→ 从头重读', async () => {
    const path = join(dir, 'Power.log')
    await writeFile(path, 'D 09:00:00.000 aaaaaaaaaaaaaaaaaaaa\nD 09:00:01.000 bbbbbbbbbbbbbbbbbbbb\n', 'utf8')
    void (async () => {
      await delay(10)
      await writeFile(path, 'D 08:00:00.000 rotated\n', 'utf8')
    })()
    const harness = makeTail({
      nextPath: () => path,
      until: flat => flat.includes('D 08:00:00.000 rotated'),
    })
    await harness.run
    expect(harness.flat()).toContain('D 08:00:00.000 rotated')
  }, 10_000)

  it('onLines 返回 false 立即结束；stop() 亦结束循环', async () => {
    const path = join(dir, 'Power.log')
    void (async () => {
      await delay(6)
      await writeFile(path, 'D 09:00:00.000 x\n', 'utf8')
    })()
    const stopper = makeTail({ nextPath: () => path, maxTicks: 5, onLinesReturn: () => false })
    await stopper.run
    expect(stopper.batches.length).toBe(1)

    const path2 = join(dir, 'Power2.log')
    await writeFile(path2, '', 'utf8')
    const stopped = makeTail({ nextPath: () => path2, maxTicks: 10_000 })
    void (async () => {
      await delay(6)
      stopped.tail.stop()
    })()
    await stopped.run
  }, 10_000)

  it('文件不存在窗口：等待后出现仍可读取', async () => {
    const path = join(dir, 'Power.log')
    expect(existsSync(path)).toBe(false)
    void (async () => {
      await delay(6)
      await writeFile(path, 'D 09:00:00.000 appeared\n', 'utf8')
    })()
    const harness = makeTail({
      nextPath: () => path,
      until: flat => flat.includes('D 09:00:00.000 appeared'),
    })
    await harness.run
    expect(harness.flat()).toContain('D 09:00:00.000 appeared')
  }, 10_000)
})

describe('PowerLogTail 默认依赖', () => {
  it('不注入 sleep/shouldStop/pollIntervalMs 时使用真实默认并可 stop', async () => {
    const path = join(dir, 'Power.log')
    await writeFile(path, '', 'utf8')
    const batches: string[][] = []
    const tail = new PowerLogTail({
      resolvePath: async () => path,
      onLines: (lines) => {
        batches.push(lines)
      },
    })
    const pending = tail.run()
    await delay(20)
    await writeFile(path, 'D 09:00:00.000 default-timer line\n', 'utf8')
    await delay(1200)
    tail.stop()
    await pending
    expect(batches.flat().some(l => l.includes('default-timer line'))).toBe(true)
  }, 10_000)

  it('监听中文件被删除进入等待窗口，句柄关闭', async () => {
    const path = join(dir, 'Power.log')
    await writeFile(path, 'D 09:00:00.000 x\n', 'utf8')
    let deleted = false
    const harness = makeTail({
      nextPath: () => path,
      maxTicks: 80,
      until: () => deleted,
    })
    setTimeout(() => {
      void rm(path, { force: true }).then(() => {
        deleted = true
      })
    }, 6)
    await harness.run
    expect(deleted).toBe(true)
  }, 10_000)
})
