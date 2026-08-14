// @ts-check
/**
 * Electron main process for the DeepSeek Harness desktop shell.
 *
 * The shell spawns the existing `dsh web` backend (node:http on a loopback
 * port chosen by the OS via `--port 0`), reads the printed readiness URL from
 * stdout, then loads it in a BrowserWindow. The Web UI is same-origin with its
 * backend, so the full HTTP + WebSocket transport and trust perimeter are
 * reused with no protocol changes.
 *
 * CommonJS is deliberate: the main process only needs `electron` plus Node
 * built-ins and never imports workspace packages, so staying CJS sidesteps
 * ESM-main-process version pitfalls. This package is private and unpublished.
 */
'use strict'

const { app, BrowserWindow, shell, nativeTheme, ipcMain, dialog } = require('electron')
const { spawn, execFileSync } = require('node:child_process')
const http = require('node:http')
const path = require('node:path')

/** Repository root (this file lives at apps/desktop/src/main.cjs). */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
/** CLI entry that `pnpm dsh` runs from source. */
const CLI_BIN = path.join(REPO_ROOT, 'apps', 'cli', 'src', 'bin.ts')
/** Matches the `dsh web: http://127.0.0.1:<port>` readiness line. */
const READY_RE = /http:\/\/127\.0\.0\.1:(\d+)/

const HEALTH_TIMEOUT_MS = 30_000
const HEALTH_INTERVAL_MS = 200

/** @type {import('node:child_process').ChildProcess | null} */
let backend = null
/** @type {Electron.BrowserWindow | null} */
let win = null
let quitting = false

// Title-bar controls: the custom title bar is injected into the renderer by
// preload.cjs and calls back over these channels.
ipcMain.on('win:minimize', () => win?.minimize())
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('win:close', () => win?.close())

/**
 * Resolve how to launch the backend. Packaged: run the built lib/bin.js from
 * resources/backend under the user's Node. Dev: run the source CLI via tsx.
 * @returns {{ cwd: string, cmd: string, args: string[] }}
 */
function backendSpec () {
  if (app.isPackaged) {
    const backendRoot = path.join(process.resourcesPath, 'backend')
    return { cwd: backendRoot, cmd: 'node', args: [path.join(backendRoot, 'lib', 'bin.js'), 'web', '--port', '0'] }
  }
  return { cwd: REPO_ROOT, cmd: 'node', args: ['--import', 'tsx/esm', CLI_BIN, 'web', '--port', '0'] }
}

const MIN_NODE_MAJOR = 22

/**
 * Verify the user's Node on PATH satisfies the backend's minimum. Returns an
 * error message to surface (and quit) or null when acceptable.
 * @returns {string | null}
 */
function checkNode () {
  let version
  try {
    version = execFileSync('node', ['-v'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
  } catch {
    return 'Could not find Node.js on PATH. Install Node.js >= 22.19 (https://nodejs.org) and relaunch DeepSeek Harness.'
  }
  const major = Number((/^v?(\d+)/.exec(version) ?? [])[1])
  if (!major || major < MIN_NODE_MAJOR) {
    return `DeepSeek Harness requires Node.js >= 22.19, but found ${version}. Please upgrade at https://nodejs.org.`
  }
  return null
}

/**
 * Spawn the `dsh web` backend with an OS-assigned loopback port and resolve
 * once its readiness URL is printed.
 * @returns {Promise<number>} the resolved port
 */
function startBackend () {
  return new Promise((resolve, reject) => {
    // Use the `node` on PATH (not Electron's bundled node) so the backend runs
    // under a real, project-supported Node version. In dev it runs the source
    // CLI via tsx; packaged it runs the built lib/bin.js from resources/backend.
    const spec = backendSpec()
    backend = spawn(
      spec.cmd,
      spec.args,
      {
        cwd: spec.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    )

    let settled = false
    const fail = (msg) => {
      if (!settled) {
        settled = true
        reject(new Error(msg))
      }
    }

    const onStdout = (chunk) => {
      const text = chunk.toString()
      process.stdout.write(`[dsh] ${text}`)
      if (settled) return
      const match = READY_RE.exec(text)
      if (match) {
        settled = true
        resolve(Number(match[1]))
      }
    }
    backend.stdout.on('data', onStdout)
    backend.stderr.on('data', (chunk) => process.stderr.write(`[dsh] ${chunk}`))

    backend.on('error', (err) => fail(`failed to spawn backend: ${err.message}`))
    backend.on('exit', (code) => {
      if (!settled && !quitting) {
        fail(`backend exited before becoming ready (code ${code})`)
      }
    })
  })
}

/**
 * Poll `GET /` until it answers 200, or reject once the deadline passes.
 * @param {number} port
 * @returns {Promise<void>}
 */
function waitForReady (port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolve()
        if (Date.now() > deadline) return reject(new Error('backend did not return 200 in time'))
        setTimeout(tick, HEALTH_INTERVAL_MS)
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('backend unreachable before deadline'))
        setTimeout(tick, HEALTH_INTERVAL_MS)
      })
    }
    tick()
  })
}

/**
 * @param {number} port
 */
function createWindow (port) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    // Frameless: a custom title bar (brand + window buttons) is injected by
    // preload.cjs and styled with the app's CSS variables, so it tracks the
    // light/dark theme instead of using the OS chrome.
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#151517' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  // Keep the renderer's maximize/restore button icon in sync.
  win.on('maximize', () => win?.webContents.send('win:maximize-changed', true))
  win.on('unmaximize', () => win?.webContents.send('win:maximize-changed', false))
  win.loadURL(`http://127.0.0.1:${port}/`)

  // Open external links in the user's browser, never inside the shell.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:')) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.on('closed', () => {
    win = null
  })
}

/**
 * Kill the backend process tree across platforms without external deps.
 */
function killBackend () {
  if (!backend) return
  quitting = true
  try {
    if (process.platform === 'win32') {
      // `/T` kills the whole descendant tree.
      spawn('taskkill', ['/pid', String(backend.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else if (backend.pid) {
      // Negative PID targets the child's process group (spawned detached).
      try {
        process.kill(-backend.pid, 'SIGTERM')
      } catch {
        backend.kill('SIGTERM')
      }
    } else {
      backend.kill('SIGTERM')
    }
  } catch {
    // Best effort: ignore teardown failures during quit.
  }
  backend = null
}

async function boot () {
  const nodeError = checkNode()
  if (nodeError) {
    await dialog.showMessageBox({ type: 'error', title: 'Node.js required', message: nodeError })
    app.quit()
    return
  }
  try {
    const port = await startBackend()
    await waitForReady(port)
    createWindow(port)
  } catch (err) {
    console.error('[desktop] startup failed:', err.message)
    killBackend()
    app.quit()
  }
}

app.whenReady().then(boot)

app.on('window-all-closed', () => {
  killBackend()
  app.quit()
})

app.on('before-quit', killBackend)
