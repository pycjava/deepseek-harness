/**
 * 炉石日志杂务。
 *
 * - 找安装目录：常见候选 → 注册表 InstallLocation 兜底（reg query 子进程，
 *   零 npm 依赖）
 * - 写 log.config（HDT 标准内容，备份后覆盖，支持一键回滚）
 * - 解析 Power.log 路径：国服安装目录 Logs/时间戳子目录/ 取最新，
 *   全球版 LocalAppData
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 写入 log.config 的 HDT 标准内容（Power/Zone/GameState/LoadingScreen 开文件日志）。 */
export const LOG_CONFIG_CONTENT = `[Power]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false

[Zone]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false

[GameState]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false

[LoadingScreen]
LogLevel=1
FilePrinting=true
ConsolePrinting=false
ScreenPrinting=false
`

/** 覆盖 log.config 前的备份文件名后缀。 */
export const BACKUP_SUFFIX = '.bak.ntetoolbox'

/** log.config 启用/回滚操作的结果状态。 */
export interface LogConfigStatus {
  action: 'created' | 'updated' | 'already_ok' | 'restored'
  path: string
  backupPath: string | null
  message: string
}

/** reg query 读注册表 InstallLocation（任何失败静默跳过）。 */
async function registryInstallDirs(): Promise<string[]> {
  /* v8 ignore start -- 注册表探测仅 win32 执行：Linux 覆盖车道无法运行；只读查询、结果不参与断言 */
  if (process.platform !== 'win32') return []
  const roots = ['HKLM', 'HKCU']
  const subs = [
    'SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone',
    'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone',
  ]
  const results: string[] = []
  for (const root of roots) {
    for (const sub of subs) {
      try {
        const { stdout } = await execFileAsync('reg', ['query', `${root}\\${sub}`, '/v', 'InstallLocation'])
        const m = /InstallLocation\s+REG_(?:_SZ|EXPAND_SZ)\s+(.+)/.exec(stdout.trim())
        const location = m?.[1]?.trim()
        if (location) results.push(location)
      } catch {
        // 键不存在或 reg 不可用：跳过
      }
    }
  }
  return results
  /* v8 ignore stop */
}

/**
 * 炉石安装目录：常见候选 → 注册表兜底（校验 Hearthstone.exe 存在）。
 * @returns 找到的安装目录；全部候选未命中时为 null。
 */
export async function hearthstoneInstallDir(): Promise<string | null> {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Hearthstone'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Hearthstone'),
    ...(await registryInstallDirs()),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'Hearthstone.exe'))) return candidate
  }
  return null
}

/**
 * 炉石 LocalAppData 目录（log.config 所在）。
 * @returns LocalAppData 下的 Blizzard/Hearthstone 目录路径。
 */
export function hearthstoneDataDir(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(local, 'Blizzard', 'Hearthstone')
}

/**
 * log.config 完整路径。
 * @returns 炉石数据目录下 log.config 的路径。
 */
export function logConfigPath(): string {
  return join(hearthstoneDataDir(), 'log.config')
}

/**
 * 最新 Power.log 路径：国服时间戳子目录 → 全球版 LocalAppData。
 * @returns 最新的 Power.log 文件路径。
 */
export async function powerLogPath(): Promise<string> {
  const install = await hearthstoneInstallDir()
  if (install) {
    const logsRoot = join(install, 'Logs')
    if (existsSync(logsRoot)) {
      try {
        const entries = await readdir(logsRoot, { withFileTypes: true })
        const candidates = entries
          .filter(e => e.isDirectory() && existsSync(join(logsRoot, e.name, 'Power.log')))
          .map(e => e.name)
          .sort()
          .reverse()
        const latest = candidates[0]
        if (candidates.length > 0 && latest !== undefined) {
          return join(logsRoot, latest, 'Power.log')
        }
      } catch {
        // 读取失败回退 LocalAppData
      }
    }
  }
  return join(hearthstoneDataDir(), 'Logs', 'Power.log')
}

/**
 * 确保 log.config 存在且开启 Power 日志（覆盖前备份）。
 * @param backup - 覆盖已有配置前是否先备份（默认 true）。
 * @returns 本次操作的状态（created/updated/already_ok）。
 */
export async function ensureLogConfig(backup = true): Promise<LogConfigStatus> {
  const target = logConfigPath()
  await mkdir(join(target, '..'), { recursive: true })

  if (existsSync(target)) {
    /* v8 ignore next -- 不可读的既有 log.config 视同未开启；Windows 管理员权限下无法构造 */
    const existing = await readFile(target, 'utf-8').catch(() => '')
    if (existing.includes('[Power]') && existing.includes('FilePrinting=true')) {
      return {
        action: 'already_ok',
        path: target,
        backupPath: null,
        message: 'log.config 已开启 Power 日志（FilePrinting=true），无需修改。',
      }
    }
    let backupPath: string | null = null
    if (backup) {
      backupPath = target + BACKUP_SUFFIX
      await copyFile(target, backupPath)
    }
    await writeFile(target, LOG_CONFIG_CONTENT, 'utf-8')
    return {
      action: 'updated',
      path: target,
      backupPath,
      message: 'log.config 已更新（原文件已备份）。',
    }
  }

  await writeFile(target, LOG_CONFIG_CONTENT, 'utf-8')
  return {
    action: 'created',
    path: target,
    backupPath: null,
    message: 'log.config 已创建（首次启用炉石日志）。',
  }
}

/**
 * 一键回滚：恢复备份，或删除工具创建的 log.config。
 * @returns 本次操作的状态（action 固定为 restored）。
 */
export async function restoreLogConfig(): Promise<LogConfigStatus> {
  const target = logConfigPath()
  const backupPath = target + BACKUP_SUFFIX
  if (!existsSync(backupPath)) {
    if (existsSync(target)) {
      await unlink(target)
      return {
        action: 'restored',
        path: target,
        backupPath: null,
        message: '已删除工具创建的 log.config（炉石将停止写日志）。',
      }
    }
    return {
      action: 'restored',
      path: target,
      backupPath: null,
      message: '无需回滚（log.config 不存在且无备份）。',
    }
  }
  await rename(backupPath, target)
  return {
    action: 'restored',
    path: target,
    backupPath: null,
    message: '已恢复原始 log.config。',
  }
}
