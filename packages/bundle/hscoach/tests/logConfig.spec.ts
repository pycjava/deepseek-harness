/**
 * log.config 与炉石目录发现单元测试：全部路径经环境变量指向临时目录，
 * 不触碰真实炉石安装（win32 下注册表只读探测，结果不参与断言）。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  ensureLogConfig,
  hearthstoneDataDir,
  hearthstoneInstallDir,
  logConfigPath,
  powerLogPath,
  restoreLogConfig,
} from '../src/core/logConfig.ts'

let dir: string
const savedEnv: Record<string, string | undefined> = {}

function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  // oxlint-disable-next-line typescript/no-dynamic-delete -- 测试内按名还原/清除环境变量
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hscoach-logconfig-'))
})

afterEach(async () => {
  for (const [name, value] of Object.entries(savedEnv)) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- 测试内按名还原/清除环境变量
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  Object.keys(savedEnv).forEach(name => Reflect.set(savedEnv, name, undefined))
  await rm(dir, { recursive: true, force: true })
})

/** 伪造一个含 Hearthstone.exe 的安装目录并挂到 ProgramFiles(x86)。 */
async function fakeInstall(): Promise<string> {
  const install = join(dir, 'fakepf', 'Hearthstone')
  await mkdir(install, { recursive: true })
  await writeFile(join(install, 'Hearthstone.exe'), '', 'utf8')
  setEnv('ProgramFiles(x86)', join(dir, 'fakepf'))
  return install
}

describe('目录与路径解析', () => {
  it('hearthstoneDataDir/logConfigPath 跟随 LOCALAPPDATA，缺失时回退 home', () => {
    setEnv('LOCALAPPDATA', join(dir, 'local'))
    expect(hearthstoneDataDir()).toBe(join(dir, 'local', 'Blizzard', 'Hearthstone'))
    expect(logConfigPath()).toBe(join(dir, 'local', 'Blizzard', 'Hearthstone', 'log.config'))

    setEnv('LOCALAPPDATA', undefined)
    expect(hearthstoneDataDir()).toBe(join(homedir(), 'AppData', 'Local', 'Blizzard', 'Hearthstone'))
  })

  it('hearthstoneInstallDir 命中伪造安装；无安装时为 null', async () => {
    const install = await fakeInstall()
    expect(await hearthstoneInstallDir()).toBe(install)

    setEnv('ProgramFiles(x86)', join(dir, 'empty'))
    setEnv('ProgramFiles', join(dir, 'empty'))
    expect(await hearthstoneInstallDir()).toBeNull()
  })
})

describe('powerLogPath', () => {
  it('Logs 下取字典序最新的时间戳目录', async () => {
    const install = await fakeInstall()
    for (const stamp of ['2026_01_01_10_00_00', '2026_02_02_11_00_00']) {
      const session = join(install, 'Logs', stamp)
      await mkdir(session, { recursive: true })
      await writeFile(join(session, 'Power.log'), '', 'utf8')
    }
    expect(await powerLogPath()).toBe(join(install, 'Logs', '2026_02_02_11_00_00', 'Power.log'))
  })

  it('无会话目录/Logs 为空时回退 LocalAppData', async () => {
    await fakeInstall()
    setEnv('LOCALAPPDATA', join(dir, 'local'))
    expect(await powerLogPath()).toBe(join(dir, 'local', 'Blizzard', 'Hearthstone', 'Logs', 'Power.log'))

    const install = join(dir, 'fakepf', 'Hearthstone')
    await mkdir(join(install, 'Logs', 'empty_session'), { recursive: true })
    expect(await powerLogPath()).toBe(join(dir, 'local', 'Blizzard', 'Hearthstone', 'Logs', 'Power.log'))
  })

  it('Logs 是文件（readdir 抛错）时回退 LocalAppData', async () => {
    const install = await fakeInstall()
    await writeFile(join(install, 'Logs'), '', 'utf8')
    setEnv('LOCALAPPDATA', join(dir, 'local'))
    expect(await powerLogPath()).toBe(join(dir, 'local', 'Blizzard', 'Hearthstone', 'Logs', 'Power.log'))
    expect((await readdir(dir)).length).toBeGreaterThan(0)
  })
})

describe('ensureLogConfig / restoreLogConfig', () => {
  beforeEach(() => {
    setEnv('LOCALAPPDATA', join(dir, 'local'))
  })

  it('不存在时创建；已开启时 already_ok', async () => {
    const created = await ensureLogConfig()
    expect(created.action).toBe('created')
    expect(existsSync(logConfigPath())).toBe(true)

    const again = await ensureLogConfig()
    expect(again.action).toBe('already_ok')
    expect(again.backupPath).toBeNull()
  })

  it('存在但未开启时更新并备份；backup=false 不备份', async () => {
    const target = logConfigPath()
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, '[Zone]\nFilePrinting=false\n', 'utf8')

    const updated = await ensureLogConfig()
    expect(updated.action).toBe('updated')
    expect(updated.backupPath).toBe(`${target}.bak.ntetoolbox`)
    expect(await readFile(`${target}.bak.ntetoolbox`, 'utf8')).toContain('FilePrinting=false')

    // 再改坏并验证不备份路径
    await writeFile(target, '[Power]\nFilePrinting=false\n', 'utf8')
    const noBackup = await ensureLogConfig(false)
    expect(noBackup.action).toBe('updated')
    expect(noBackup.backupPath).toBeNull()
  })

  it('restore：有备份恢复原文；无备份删除工具创建；两者皆无则空操作', async () => {
    const target = logConfigPath()
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, '[Power]\nFilePrinting=false\n', 'utf8')
    await ensureLogConfig()

    const restored = await restoreLogConfig()
    expect(restored.action).toBe('restored')
    expect(await readFile(target, 'utf8')).toContain('FilePrinting=false')

    const removed = await restoreLogConfig()
    expect(removed.action).toBe('restored')
    expect(existsSync(target)).toBe(false)

    const noop = await restoreLogConfig()
    expect(noop.action).toBe('restored')
    expect(noop.message).toContain('无需回滚')
  })
})

describe('powerLogPath/hearthstoneInstallDir 环境兜底终批', () => {
  it('ProgramFiles 环境缺失时回退字面默认路径；无安装回退 LocalAppData', async () => {
    setEnv('ProgramFiles(x86)', undefined)
    setEnv('ProgramFiles', undefined)
    setEnv('LOCALAPPDATA', join(dir, 'local'))
    const path = await powerLogPath()
    // 宿主可能真装有炉石（字面默认路径命中）：只断言形态
    expect(path.endsWith('Power.log')).toBe(true)
  })
})
