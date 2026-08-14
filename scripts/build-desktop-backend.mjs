#!/usr/bin/env node
/**
 * Build the self-contained backend closure for the desktop app.
 *
 * Mirrors scripts/build-exe-for-python-sdk.ts's deploy + symlink-materialization
 * strategy, but drops the pkg/SEA step: the desktop backend runs under the
 * user's Node (>=22.19), so we only need a flat, symlink-free closure that
 * `node lib/bin.js web` can load. Output: dist-desktop/backend.
 *
 * Pipeline: build (optional) -> pnpm deploy --prod -> restore legacy hoists ->
 * materialize staged symlinks -> ensure frontend dist -> verify standalone run.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
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
  await run('deploy', pnpmBin(), [
    '--filter', MANIFEST, 'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted',
    '--config.link-workspace-packages=true',
    STAGING,
  ])
  await restoreLegacyHoists()
  await materializeStagedLinks()
  await restoreAllWorkspacePackages()
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

/**
 * Spawn the staged backend and confirm it serves the UI (HTTP 200) on a
 * loopback port. This is the go/no-go check for the whole packaging route.
 */
async function verifyRun() {
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

function report() {
  const entry = join(STAGING, ENTRY)
  console.log(`build-desktop-backend: staging at ${STAGING} (entry ${statSync(entry).size} bytes)`)
}

async function main() {
  const skipBuild = process.argv.slice(2).includes('--skip-build')
  await build(skipBuild)
  await deployStaging()
  await ensureFrontendDist()
  await verifyRun()
  report()
  console.log('build-desktop-backend: done.')
}

await main()
