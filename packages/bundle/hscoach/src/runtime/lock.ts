/**
 * 单实例锁：同一发布目录（advice/stats/history 等共享文件）同时只允许
 * 一个教练实例 tail 日志，否则同一局会被重复记录、发布文件互相覆盖。
 *
 * 锁文件内容为持有者 PID。创建走 O_EXCL 原子抢占；文件已存在时按 PID
 * 存活性判定——持有者已死（崩溃残留）或内容损坏则删除后重试接管，因此
 * 崩溃残留自愈，无需手工清理。存活即拒绝（同进程内第二个实例同样拒绝，
 * PID 相同不代表同一实例）。
 */
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

/** 锁文件名（沿用 NTEToolbox hscoachd 的既有名字，升级后无缝接管）。 */
export const LOCK_FILENAME = 'hscoachd.lock'

/** 陈旧锁删除重试上限；超出（如锁路径不可删除）视为未获取。 */
const MAX_STALE_RETRIES = 5

/** 已获取的单实例锁。 */
export interface InstanceLock {
  /** 锁文件路径。 */
  path: string
  /** 持有者 PID。 */
  pid: number
  /** 释放锁（删除锁文件）；幂等，文件已消失时静默成功。 */
  release(): Promise<void>
}

/**
 * PID 是否存活（signal 0 探测）。
 * @param pid - 要探测的进程 id。
 * @returns 存活返回 true；EPERM（进程存在但无权限发信号）同样视为存活。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* v8 ignore next -- EPERM 臂需无权限的他人进程，测试宿主恒为管理员不可构造 */
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 锁文件完整路径。
 * @param publishDir - 发布目录。
 * @returns 锁文件路径。
 */
export function lockPath(publishDir: string): string {
  return join(publishDir, LOCK_FILENAME)
}

/**
 * 读取锁文件记录的持有者 PID。
 * @param path - 锁文件路径。
 * @returns 持有者 PID；文件缺失或内容损坏（非正整数）时为 null。
 */
export async function readLockPid(path: string): Promise<number | null> {
  const text = await readFile(path, 'utf-8').catch(() => '')
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * 获取发布目录的单实例锁。
 * @param publishDir - 发布目录（不存在时创建）。
 * @param pid - 记入锁的持有者 PID；缺省为当前进程。
 * @returns 成功返回锁句柄；另一存活实例持有锁或陈旧锁删除重试超限时为 null。
 */
export async function acquireInstanceLock(
  publishDir: string,
  pid = process.pid,
): Promise<InstanceLock | null> {
  const path = lockPath(publishDir)
  await mkdir(publishDir, { recursive: true })
  const unlinkQuiet = (): Promise<void> => unlink(path).catch(() => {})
  for (let attempt = 0; attempt <= MAX_STALE_RETRIES; attempt++) {
    let handle: FileHandle
    try {
      handle = await open(path, 'wx')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      /* v8 ignore next -- 非 EEXIST 失败（如锁父目录被并发删除）在单进程测试内不可构造 */
      if (code !== 'EEXIST') throw error
      const existing = await readLockPid(path)
      if (existing !== null && isPidAlive(existing)) return null
      // 陈旧锁（持有者已死/内容损坏）→ 删除后重试抢占
      await unlinkQuiet()
      continue
    }
    await handle.writeFile(String(pid), 'utf-8')
    await handle.close()
    let released = false
    return {
      path,
      pid,
      release: () => {
        if (released) return Promise.resolve()
        released = true
        return unlinkQuiet()
      },
    }
  }
  return null
}
