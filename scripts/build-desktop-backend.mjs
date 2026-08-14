#!/usr/bin/env node
/**
 * Build the self-contained backend closure for the desktop app.
 *
 * Mirrors scripts/build-exe-for-python-sdk.ts's deploy + symlink-materialization
 * strategy, but drops the pkg/SEA step: the desktop backend runs under the
 * user's Node (>=22.19), so we only need a flat, symlink-free closure that
 * `node lib/bin.js web` can load. Output: dist-desktop/backend.
 *
 * Pipeline: build (optional) -> pnpm deploy --prod (with supportedArchitectures
 * injected for the deploy only) -> restore legacy hoists -> materialize staged
 * symlinks -> ensure frontend dist -> prune runtime-dead files and non-target
 * binaries -> verify standalone run (native arch only).
 *
 * `--arch x64|arm64` (default x64) selects the Windows CPU architecture the
 * closure keeps; deploy always stages both so cross-arch builds work on any
 * host.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, utimes, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The CLI package whose dependency closure defines the backend. */
const MANIFEST = '@deepseek-ai/dsh'
/** Flat, symlink-free closure output directory. */
const STAGING = resolve(root, 'dist-desktop', 'backend')
/** Legacy deploy may hoist direct deps back to the workspace node_modules. */
const SOURCE_NODE_MODULES = resolve(root, 'node_modules')
/** Backend entry inside the closure. */
const ENTRY = join('lib', 'bin.js')
/** Frontend dist must be resolvable inside the closure (require.resolve by web-app). */
const FRONTEND_DIST = join('node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
/** Whose supportedArchitectures gates deploy's platform-optional selection. */
const WORKSPACE_YAML = resolve(root, 'pnpm-workspace.yaml')
/** Windows CPU architectures Electron 43 publishes installers for. */
const ARCHES = ['x64', 'arm64']

const pnpmBin = () => (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')

/**
 * Run one subprocess with inherited stdio; reject on non-zero exit.
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 */
function run(label, command, args) {
  const printable = [command, ...args].map((p) => (p.includes(' ') ? JSON.stringify(p) : p)).join(' ')
  console.log(`build-desktop-backend: ${label}: ${printable}`)
  return new Promise((resolveP, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' }, shell: process.platform === 'win32' })
    child.once('error', (err) => reject(new Error(`${label} failed to spawn: ${err.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveP()
      reject(new Error(`${label} failed (${code === null ? `signal ${signal}` : `exit ${code}`})`))
    })
  })
}

/** Build all artifacts unless --skip-build. */
async function build(skipBuild) {
  if (skipBuild) {
    console.log('build-desktop-backend: skipping build (--skip-build)')
    return
  }
  await run('build', pnpmBin(), ['run', 'build'])
}

/** Clear and deploy the production closure into staging, then flatten links. */
async function deployStaging() {
  if (STAGING === root || root.startsWith(STAGING + sep)) {
    throw new Error(`refusing to clear staging ${STAGING}: contains repo root`)
  }
  console.log(`build-desktop-backend: clearing ${STAGING}`)
  await rm(STAGING, { recursive: true, force: true })
  await deployWithWindowsArches()
  await restoreLegacyHoists()
  await materializeStagedLinks()
  await restoreAllWorkspacePackages()
}

/**
 * Run the deploy with `supportedArchitectures` narrowed to Windows x64+arm64,
 * restoring pnpm-workspace.yaml immediately after. pnpm 11 selects platform
 * optional dependencies (sharp's `@img/*`, koffi's `@koromix/*`,
 * node-pty-adjacent leaves) from workspace settings, not CLI flags or env:
 * without this the closure carries only the host architecture's binaries and a
 * cross-arch build ships dead addons. Both CPUs are requested;
 * pruneRuntimeDeadWeight keeps the target and drops the rest.
 */
async function deployWithWindowsArches() {
  const original = await readFile(WORKSPACE_YAML, 'utf8')
  if (original.includes('supportedArchitectures:')) {
    throw new Error('pnpm-workspace.yaml already declares supportedArchitectures; refusing to inject a second block')
  }
  const stats = statSync(WORKSPACE_YAML)
  const injected = original
    + '\n# Injected by scripts/build-desktop-backend.mjs for the deploy below; restored right after.\n'
    + 'supportedArchitectures:\n'
    + '  os:\n'
    + '    - win32\n'
    + '  cpu:\n'
    + '    - x64\n'
    + '    - arm64\n'
  await writeFile(WORKSPACE_YAML, injected, 'utf8')
  try {
    await run('deploy', pnpmBin(), [
      '--filter', MANIFEST, 'deploy', '--legacy', '--prod',
      '--config.node-linker=hoisted',
      '--config.link-workspace-packages=true',
      STAGING,
    ])
  } finally {
    await writeFile(WORKSPACE_YAML, original, 'utf8')
    // Leave the file's timestamps as they were so stat-based watchers see the
    // committed state, not a transient rewrite.
    await utimes(WORKSPACE_YAML, stats.atime, stats.mtime)
  }
}

/**
 * Collect every workspace package directory (packages/&lt;group&gt;/&lt;pkg&gt; and
 * vendor/&lt;pkg&gt;) that has a manifest.
 * @returns {Promise<string[]>}
 */
async function collectWorkspacePackageDirs() {
  const dirs = []
  const packagesRoot = resolve(root, 'packages')
  for (const group of await readdir(packagesRoot, { withFileTypes: true }).catch(() => [])) {
    if (!group.isDirectory()) continue
    const groupPath = join(packagesRoot, group.name)
    for (const pkg of await readdir(groupPath, { withFileTypes: true }).catch(() => [])) {
      if (!pkg.isDirectory()) continue
      const pkgPath = join(groupPath, pkg.name)
      if (existsSync(join(pkgPath, 'package.json'))) dirs.push(pkgPath)
    }
  }
  const vendorRoot = resolve(root, 'vendor')
  for (const pkg of await readdir(vendorRoot, { withFileTypes: true }).catch(() => [])) {
    if (!pkg.isDirectory()) continue
    const pkgPath = join(vendorRoot, pkg.name)
    if (existsSync(join(pkgPath, 'package.json'))) dirs.push(pkgPath)
  }
  return dirs
}

/**
 * Backfill every workspace package the deploy omitted. Cordis loads plugins by
 * bare package name at runtime, and many dsh-* / cordis-* packages are pure
 * root peers (no package declares them as a dependency, only as a peer), so
 * `pnpm deploy` never copies them. Walking the whole workspace and copying any
 * built lib/ that is missing from the closure closes those gaps in one pass.
 */
async function restoreAllWorkspacePackages() {
  const dirs = await collectWorkspacePackageDirs()
  const restored = []
  for (const srcDir of dirs) {
    const pkg = JSON.parse(await readFile(join(srcDir, 'package.json'), 'utf8'))
    if (!pkg.name) continue
    const dest = join(STAGING, 'node_modules', pkg.name)
    if (existsSync(dest)) continue
    if (!existsSync(join(srcDir, 'lib'))) continue
    const nested = join(srcDir, 'node_modules')
    await mkdir(dest, { recursive: true })
    await cp(srcDir, dest, {
      recursive: true, dereference: true,
      filter: (p) => p !== nested && !p.startsWith(nested + sep),
    })
    restored.push(pkg.name)
  }
  if (restored.length) console.log(`build-desktop-backend: restored ${restored.length} missing workspace packages (root peers)`)
}

/**
 * Restore direct deps that pnpm's legacy hoister leaves beside the deploy source
 * instead of in the target. Copies dereferenced (real files), skipping nested
 * node_modules to keep one flat Cordis instance.
 */
async function restoreLegacyHoists() {
  const manifestPath = join(STAGING, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const deps = Object.keys(manifest.dependencies ?? {})
  const restored = []
  for (const dep of deps.sort()) {
    const dest = join(STAGING, 'node_modules', dep)
    if (existsSync(dest)) continue
    const src = join(SOURCE_NODE_MODULES, dep)
    if (!existsSync(src)) {
      throw new Error(`deployed dependency ${dep} absent from both staging and ${SOURCE_NODE_MODULES}`)
    }
    await mkdir(dirname(dest), { recursive: true })
    const nested = join(src, 'node_modules')
    await cp(src, dest, {
      recursive: true, dereference: true,
      filter: (p) => p !== nested && !p.startsWith(nested + sep),
    })
    restored.push(dep)
  }
  const missing = deps.filter((d) => !existsSync(join(STAGING, 'node_modules', d)))
  if (missing.length) throw new Error(`staged dependencies still missing: ${missing.join(', ')}`)
  if (restored.length) console.log(`build-desktop-backend: restored legacy hoists: ${restored.join(', ')}`)
}

/** Replace every remaining symlink under staging/node_modules with real files. */
async function materializeStagedLinks() {
  const nm = join(STAGING, 'node_modules')
  let link = await findSymlink(nm)
  let count = 0
  while (link) {
    const segments = link.slice(nm.length + 1).split(sep)
    const binIdx = segments.lastIndexOf('.bin')
    if (binIdx >= 0) {
      await rm(join(nm, ...segments.slice(0, binIdx + 1)), { recursive: true, force: true })
    } else {
      const real = await realpath(link)
      const nested = join(real, 'node_modules')
      await rm(link, { recursive: true, force: true })
      await cp(real, link, {
        recursive: true, dereference: true,
        filter: (p) => p !== nested && !p.startsWith(nested + sep),
      })
    }
    count++
    link = await findSymlink(nm)
  }
  console.log(`build-desktop-backend: materialized ${count} staged symlinks`)
}

/** Depth-first search for the first symbolic link below a directory. */
async function findSymlink(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    let st
    try {
      st = await lstat(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) return p
    if (st.isDirectory()) {
      const nested = await findSymlink(p)
      if (nested) return nested
    }
  }
  return undefined
}

/** Ensure the web frontend dist is resolvable inside the closure. */
async function ensureFrontendDist() {
  const target = join(STAGING, FRONTEND_DIST)
  if (existsSync(target)) {
    console.log('build-desktop-backend: frontend dist present in closure')
    return
  }
  const src = resolve(root, 'apps', 'web', 'dist')
  if (!existsSync(join(src, 'index.html'))) {
    throw new Error(`frontend dist missing at ${src}; run without --skip-build`)
  }
  await rm(dirname(target), { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(src, dirname(target), { recursive: true })
  console.log('build-desktop-backend: copied frontend dist into closure')
}

/** Directory basenames of platform-optional leaf packages, e.g. `sharp-win32-arm64`. */
const PLATFORM_LEAF = /(?:^|[-_])(?:darwin|win32|linux|freebsd|openbsd|netbsd|android|sunos|aix)-(?:x64|arm64|ia32|arm|riscv64|loong64|ppc64|s390x)(?:[-_.].*)?$/i

/** Windows-version-scoped binary dirs, e.g. node-pty's conpty `win10-arm64`. */
const WINDOWS_CPU_DIR = /^win1[01]-(x64|arm64|ia32)$/i

/** True when a directory basename is the target architecture's Windows leaf. */
function isTargetLeaf(name, arch) {
  return new RegExp(`(?:^|[-_])win32-${arch}(?:[-_.]|$)`, 'i').test(name)
}

/**
 * Delete files the backend never loads at runtime: source maps, TypeScript
 * declarations, tsbuildinfo artifacts, non-license docs, Windows debug symbols,
 * and every binary built for another architecture (prebuildify dirs like
 * node-pty's `prebuilds/<platform>-<arch>`, platform-optional leaves like
 * `@img/sharp-win32-ia32`, and Windows-version-scoped dirs like node-pty's
 * conpty `win10-arm64`). The NSIS installer writes files one by one through
 * Defender's real-time scan, so every dead file multiplies install time.
 * Platform leaves are only deleted when they carry a package.json, which
 * separates them from same-named source directories. `.ts` sources stay: Node
 * >=22.19 type-stripping keeps them runtime-loadable, and no blanket rule
 * separates shipped-source packages from dead weight.
 * @param {string} arch target Windows CPU architecture
 * @returns {Promise<void>}
 */
async function pruneRuntimeDeadWeight(arch) {
  const FILE = /\.(map|d\.ts|tsbuildinfo|pdb)$/i
  const DOC = /\.md$/i
  const KEPT_DOC = /(licen[cs]e|notice|copying|third[-_]party)/i
  let removed = 0
  let foreign = 0
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'prebuilds') {
          for (const child of await readdir(p, { withFileTypes: true }).catch(() => [])) {
            if (child.name === `win32-${arch}`) continue
            await rm(join(p, child.name), { recursive: true, force: true })
            foreign++
          }
        } else if (PLATFORM_LEAF.test(entry.name) && !isTargetLeaf(entry.name, arch) && existsSync(join(p, 'package.json'))) {
          await rm(p, { recursive: true, force: true })
          foreign++
          continue
        } else if (WINDOWS_CPU_DIR.test(entry.name) && entry.name.toLowerCase() !== `win10-${arch}` && entry.name.toLowerCase() !== `win11-${arch}`) {
          await rm(p, { recursive: true, force: true })
          foreign++
          continue
        }
        await walk(p)
        // Drop directories pruning emptied (e.g. a types/ dir holding only
        // d.ts). Only ENOTEMPTY and access-denied refusals reach this catch.
        await rmdir(p).catch(() => {})
      } else if (FILE.test(entry.name) || (DOC.test(entry.name) && !KEPT_DOC.test(entry.name))) {
        await rm(p, { force: true })
        removed++
      }
    }
  }
  await walk(STAGING)
  console.log(`build-desktop-backend: pruned ${removed} runtime-dead files (maps, declarations, build-info, docs, debug symbols) and ${foreign} foreign-architecture entries (target win32-${arch})`)
}

/**
 * Fail loud when the closure lacks the target architecture's loadable
 * binaries. Each family is optional at the dependency-graph level, so a
 * missing family is fine; a family present without its win32-<arch> variant
 * means the deploy or prune staged dead binaries.
 * @param {string} arch target Windows CPU architecture
 * @returns {void}
 */
function assertTargetBinaries(arch) {
  const target = `win32-${arch}`
  const ptyDir = join(STAGING, 'node_modules', 'node-pty', 'prebuilds', target)
  for (const addon of ['pty.node', 'conpty.node', 'conpty_console_list.node']) {
    if (!existsSync(join(ptyDir, addon))) {
      throw new Error(`node-pty ${target} prebuild missing ${addon}; deploy did not stage target-arch binaries`)
    }
  }
  const leafFamilies = [
    ['sharp', join('node_modules', '@img', `sharp-${target}`)],
    ['koffi', join('node_modules', '@koromix', `koffi-${target}`)],
  ]
  for (const [name, leaf] of leafFamilies) {
    if (existsSync(join(STAGING, 'node_modules', name)) && !existsSync(join(STAGING, leaf))) {
      throw new Error(`${name} ships without its ${target} platform package`)
    }
  }
}

/**
 * Spawn the staged backend and confirm it serves the UI (HTTP 200) on a
 * loopback port. This is the go/no-go check for the whole packaging route.
 * Cross-arch builds skip it: the boot path dlopens target-arch addons (koffi
 * backs JSONL durability from first write), which cannot load under a host
 * node of another architecture; assertTargetBinaries covers those builds.
 * @param {string} arch target Windows CPU architecture
 */
async function verifyRun(arch) {
  if (process.platform !== 'win32' || process.arch !== arch) {
    console.log(`build-desktop-backend: skipping runtime verify: closure targets win32-${arch}, host is ${process.platform}-${process.arch}`)
    return
  }
  const entry = join(STAGING, ENTRY)
  if (!existsSync(entry)) throw new Error(`entry ${entry} missing after deploy`)
  console.log('build-desktop-backend: verifying standalone run...')
  const READY = /http:\/\/127\.0\.0\.1:(\d+)/
  await new Promise((resolveP, reject) => {
    const child = spawn('node', [entry, 'web', '--port', '0'], {
      cwd: STAGING, stdio: ['ignore', 'pipe', 'inherit'],
    })
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        reject(new Error('backend did not become ready in 90s'))
      }
    }, 90_000)
    child.stdout.on('data', (chunk) => {
      process.stdout.write(`[verify] ${chunk}`)
      if (settled) return
      const m = READY.exec(String(chunk))
      if (!m) return
      const port = Number(m[1])
      poll(port).then(() => {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        console.log(`build-desktop-backend: OK — backend served UI on :${port}`)
        resolveP()
      }).catch((err) => {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        reject(err)
      })
    })
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        reject(new Error(`backend exited before ready (code ${code})`))
      }
    })
  })
}

/** Poll GET / until 200 or the deadline. */
function poll(port) {
  const deadline = Date.now() + 30_000
  return new Promise((resolveP, reject) => {
    const tick = () => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume()
        if (res.statusCode === 200) return resolveP()
        if (Date.now() > deadline) return reject(new Error('backend did not return 200 in 30s'))
        setTimeout(tick, 200)
      })
      req.on('error', () => {
        if (Date.now() > deadline) return reject(new Error('backend unreachable before deadline'))
        setTimeout(tick, 200)
      })
    }
    tick()
  })
}

/** @param {string} dir @returns {Promise<number>} */
async function countFiles(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += await countFiles(p)
    else total++
  }
  return total
}

function report() {
  const entry = join(STAGING, ENTRY)
  console.log(`build-desktop-backend: staging at ${STAGING} (entry ${statSync(entry).size} bytes)`)
}

async function main() {
  const argv = process.argv.slice(2)
  const skipBuild = argv.includes('--skip-build')
  const archIdx = argv.indexOf('--arch')
  const arch = archIdx >= 0 ? argv[archIdx + 1] : 'x64'
  if (!ARCHES.includes(arch)) throw new Error(`unknown --arch ${arch}; expected one of ${ARCHES.join(', ')}`)
  console.log(`build-desktop-backend: target architecture win32-${arch}`)
  await build(skipBuild)
  await deployStaging()
  await ensureFrontendDist()
  await pruneRuntimeDeadWeight(arch)
  assertTargetBinaries(arch)
  await verifyRun(arch)
  report()
  console.log(`build-desktop-backend: closure file count: ${await countFiles(STAGING)}`)
  console.log('build-desktop-backend: done.')
}

await main()
