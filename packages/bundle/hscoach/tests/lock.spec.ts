/**
 * 单实例锁功能测试：原子抢占、存活冲突、陈旧/损坏锁接管、重入、
 * 释放幂等、不可删除锁的重试上限。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireInstanceLock,
  isPidAlive,
  lockPath,
  readLockPid,
  LOCK_FILENAME,
} from '../src/runtime/lock.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-lock-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('acquireInstanceLock', () => {
  it('空目录抢占成功：锁文件写入持有者 PID', async () => {
    const lock = await acquireInstanceLock(dir, 4321)
    expect(lock).not.toBeNull()
    expect(lock!.path).toBe(lockPath(dir))
    expect(lock!.pid).toBe(4321)
    expect(await readFile(lockPath(dir), 'utf-8')).toBe('4321')
    expect(lockPath(dir).endsWith(LOCK_FILENAME)).toBe(true)
  })

  it('发布目录不存在时自动创建', async () => {
    const nested = join(dir, 'a', 'b')
    const lock = await acquireInstanceLock(nested)
    expect(lock).not.toBeNull()
    expect(existsSync(lockPath(nested))).toBe(true)
    await lock!.release()
  })

  it('另一存活实例持有锁：返回 null，锁文件不被改写', async () => {
    // ppid（vitest 主进程）在测试期间必然存活
    const holder = await acquireInstanceLock(dir, process.ppid)
    expect(holder).not.toBeNull()
    const second = await acquireInstanceLock(dir)
    expect(second).toBeNull()
    expect(await readFile(lockPath(dir), 'utf-8')).toBe(String(process.ppid))
  })

  it('崩溃残留（持有者已死）：接管并改写 PID', async () => {
    await writeFile(lockPath(dir), '99999999', 'utf-8')
    const lock = await acquireInstanceLock(dir)
    expect(lock).not.toBeNull()
    expect(await readFile(lockPath(dir), 'utf-8')).toBe(String(process.pid))
    await lock!.release()
  })

  it('内容损坏（非正整数）：视为陈旧并接管', async () => {
    await writeFile(lockPath(dir), 'garbage', 'utf-8')
    expect(await readLockPid(lockPath(dir))).toBeNull()
    const lock = await acquireInstanceLock(dir)
    expect(lock).not.toBeNull()
    await lock!.release()
  })

  it('同 PID 存活同样拒绝（同进程第二个实例不是重入）', async () => {
    const holder = await acquireInstanceLock(dir, process.pid)
    expect(holder).not.toBeNull()
    const second = await acquireInstanceLock(dir, process.pid)
    expect(second).toBeNull()
    await holder!.release()
  })

  it('release 幂等且删除锁文件；释放后可重新获取', async () => {
    const lock = await acquireInstanceLock(dir)
    expect(lock).not.toBeNull()
    await lock!.release()
    await lock!.release()
    expect(existsSync(lockPath(dir))).toBe(false)
    const again = await acquireInstanceLock(dir)
    expect(again).not.toBeNull()
    await again!.release()
  })

  it('锁路径不可删除（目录占位）：重试超限返回 null', async () => {
    await mkdir(join(lockPath(dir), 'inner'), { recursive: true })
    await writeFile(join(lockPath(dir), 'inner', 'f.txt'), 'x', 'utf-8')
    const lock = await acquireInstanceLock(dir)
    expect(lock).toBeNull()
    // 目录占位仍然完好（未被删除）
    expect(existsSync(join(lockPath(dir), 'inner', 'f.txt'))).toBe(true)
  })
})

describe('readLockPid / isPidAlive', () => {
  it('readLockPid：缺失文件返回 null', async () => {
    expect(await readLockPid(join(dir, 'missing.lock'))).toBeNull()
  })

  it('isPidAlive：自身存活、超大 PID 不存活', () => {
    expect(isPidAlive(process.pid)).toBe(true)
    expect(isPidAlive(99999999)).toBe(false)
  })
})
