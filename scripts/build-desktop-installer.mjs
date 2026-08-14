#!/usr/bin/env node
/**
 * One-shot desktop installer build for one Windows architecture: stage the
 * backend closure, then run electron-builder for the same architecture.
 *
 * Usage: node scripts/build-desktop-installer.mjs [--arch x64|arm64] [--skip-build]
 * Artifacts land in dist-desktop/release/<arch>/ (installer + win-unpacked);
 * --skip-build forwards to build-desktop-backend.mjs (build once, then iterate
 * on packaging).
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** electron-builder reads its config relative to the app dir, not the repo root. */
const DESKTOP_DIR = resolve(root, 'apps', 'desktop')
/** Windows CPU architectures Electron 43 publishes installers for. */
const ARCHES = ['x64', 'arm64']

const argv = process.argv.slice(2)
const archIdx = argv.indexOf('--arch')
const arch = archIdx >= 0 ? argv[archIdx + 1] : 'x64'
const skipBuild = argv.includes('--skip-build')
if (!ARCHES.includes(arch)) throw new Error(`unknown --arch ${arch}; expected one of ${ARCHES.join(', ')}`)

/**
 * Resolve electron-builder's bin entry through apps/desktop's dependency
 * links. electron-builder is invoked with the host node directly, not through
 * `pnpm exec`: pnpm 11's before-run dependency check may decide to reinstall
 * the workspace (observed as a destructive `pnpm install --production` that
 * prunes devDependencies and fails the root postinstall), and packaging must
 * never mutate the dev tree.
 * @returns {string} absolute path to the electron-builder CLI entry
 */
function electronBuilderCli() {
  const requireFromDesktop = createRequire(resolve(DESKTOP_DIR, 'package.json'))
  const pkg = requireFromDesktop('electron-builder/package.json')
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin['electron-builder']
  if (!bin) throw new Error('electron-builder package.json exposes no bin entry')
  return resolve(dirname(requireFromDesktop.resolve('electron-builder/package.json')), bin)
}

/**
 * Run one subprocess with inherited stdio; reject on non-zero exit.
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {string} [cwd]
 */
function run(label, command, args, cwd = root) {
  const printable = [command, ...args].map((p) => (p.includes(' ') ? JSON.stringify(p) : p)).join(' ')
  console.log(`build-desktop-installer: ${label}: ${printable}`)
  return new Promise((resolveP, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' }, shell: process.platform === 'win32' })
    child.once('error', (err) => reject(new Error(`${label} failed to spawn: ${err.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveP()
      reject(new Error(`${label} failed (${code === null ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

console.log(`build-desktop-installer: building win32-${arch} installer`)
await run('backend closure', process.execPath, [
  resolve(root, 'scripts', 'build-desktop-backend.mjs'),
  '--arch', arch,
  ...(skipBuild ? ['--skip-build'] : []),
])
await run('electron-builder', process.execPath, [
  electronBuilderCli(),
  '--win', 'nsis', `--${arch}`,
  `--config.directories.output=${resolve(root, 'dist-desktop', 'release', arch)}`,
], DESKTOP_DIR)
console.log(`build-desktop-installer: done — dist-desktop/release/${arch}/`)
