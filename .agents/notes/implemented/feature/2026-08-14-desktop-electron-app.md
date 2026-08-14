# Agent Note: Desktop shell — Electron app that runs `dsh web` as a packaged backend

Status: implemented

English | [中文](2026-08-14-desktop-electron-app.zh.md)

## Problem

The DeepSeek Harness Web UI is the primary entry surface: `apps/web` is a Vite-built SPA, and `dsh web` boots the Cordis plugin tree (`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`) that serves the SPA from the same `node:http` server the WebSocket / fetch transports live on. Until now the only way to run it was either `pnpm dsh web` from a repo checkout (developer audience) or `npx @deepseek-ai/dsh web` from an installed npm tarball (early-adopter audience). Both routes assume the user is comfortable with a terminal, can install Node ≥ 22.19, and accepts that the UI lives at `http://127.0.0.1:3080/` rather than as a proper desktop application. A first-class desktop shell was the obvious next step, but a naive port would have to choose between copying the Web UI's whole React/Vite bundle into the shell or implementing an IPC bridge that reimplements the same-origin trust perimeter the existing HTTP + WebSocket transport already enforces.

## Decision

`apps/desktop/` is a thin Electron shell that runs the existing `dsh web` backend as a child process and loads the UI in a BrowserWindow. The backend binds `127.0.0.1` with `--port 0` so the OS picks a free port; the shell parses the readiness line, polls `GET /` until 200, then `loadURL(http://127.0.0.1:<port>/)`. Because the SPA is served by its own backend and is same-origin with it, the full HTTP + WebSocket transport and the loopback / Origin / `sec-fetch-site` trust perimeter (enforced by `packages/client/connection/src/api-request-trust.ts`) are reused unchanged — no `WebApiClient.doFetch` reimplementation, no preload RPC bridge for fetch.

The main process is CommonJS on purpose: it imports only `electron` and Node built-ins, never workspace packages. `apps/desktop/src/preload.cjs` injects a frameless title bar (brand whale + DeepSeek Harness wordmark + custom minimize / maximize-restore / close buttons) into the SPA document, with `-webkit-app-region: drag` for the bar and `no-drag` on the controls. The bar's CSS uses the SPA's own `--dsw-*` tokens, so its colors track the light / dark theme with no hard-coded palette. `#root { padding-top: 36px; box-sizing: border-box }` keeps the SPA from being clipped under the bar.

The desktop shell ships as an NSIS Windows installer built by electron-builder 26. The Electron main process, preload, and Electron runtime go into the standard `app.asar` / electron framework. The backend closure is **not** asar-packed: it ships as `resources/backend/` with its own `node_modules/`, deliberately bypassing `electron-builder`'s `nodeGypRebuild` / `npmRebuild` (set to `false`) so the prebuilt `node-pty`, `sharp`, and `koffi` addons keep their original Node ABI rather than being rebuilt against Electron's ABI. The backend closure is built by `scripts/build-desktop-backend.mjs`, which `pnpm deploy`s `@deepseek-ai/dsh` into `dist-desktop/backend`, materializes any staged symlinks, and then walks `packages/*/*/` and `vendor/*/` to backfill every workspace root peer (`@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`, `@deepseek-ai/dsh-scope`, `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-timeout`, etc.) into `node_modules`. The script then runs the staged `node lib/bin.js web --port 0` and verifies HTTP 200 from `GET /` before exiting.

`electron-builder` 26.x declares `@electron/get: ^3.0.0` but uses `ElectronDownloadCacheMode.ReadWrite`, an API that only exists from `@electron/get` 3.1.0 onward; left unconstrained, the lockfile pins 3.0.0 and the packager crashes in `resolveCacheMode`. The fix is a workspace-level override in `pnpm-workspace.yaml`: `'@electron/get': ^3.1.0`. The override is minimal (minor bump, additive API) and leaves every other consumer (electron's own install script, electron-builder's other transitive uses) working unchanged.

`electron-builder`'s `app-builder-lib` hard-excludes any `node_modules` directory sitting directly under a matcher root (`out/util/filter.js:42-45`), regardless of filter patterns — this catches the backend closure's `node_modules/` silently. The fix is to map `node_modules` as its **own** `extraResources` `from` entry, so it is the matcher root and bypasses the hard-coded exclusion.

## Alternatives considered

**`file://` load + IPC fetch bridge** — rejected. `webserver/src/index.ts:7-8` already mentions this path as a future Electron route, but it forces the shell to reimplement `WebApiClient.doFetch` so the SPA can talk to the backend, breaks the same-origin trust perimeter (loopback `Host` check, `Origin` check, `sec-fetch-site: cross-site` rejection), and turns the preload into a re-implementation of `api-request-trust.ts`. The loopback HTTP route reuses everything as-is.

**Bundling a Node runtime into the installer** — rejected. Embedding Node via `pkg --sea` or by copying `node.exe` would add ~70 MB, force ABI matching between the bundled node and every prebuilt addon, and require an explicit Node-version update policy. Requiring Node ≥ 22.19 on the user's machine (verified at startup with a friendly dialog when missing) keeps the closure's binary footprint, the addon ABI, and the install size honest. A future "double-click to install, double-click to run" build can swap in the bundled-node path without changing anything else here.

**Single-file `pkg`-built executable on Windows** — rejected. The existing `scripts/build-exe-for-python-sdk.ts` already proves this works on Linux / macOS, and it is explicitly marked "Windows is a documented non-goal". Re-deriving that route for Windows was out of scope; the present decision targets Windows only and uses electron-builder's well-trodden NSIS pipeline.

**Driving the backend with `npx @deepseek-ai/dsh web` from the shell** — rejected. That works for `pnpm`-installed dev environments but fails for tarball users (npm install does not install the `@deepseek-ai/dsh` bundle manifest as runnable inside a resource directory) and complicates the install layout. Spawning `node resources/backend/lib/bin.js web --port 0` directly is two lines and unambiguous.

## Consequences

A Windows user can run the Web UI as a first-class desktop application without a terminal. The shell inherits the full plugin runtime: bash / fs / web tools, subagent capability, agent presets, and the `__DSH_BOOT__` injection mechanism all work because the SPA still talks to the real `dsh web` over `127.0.0.1`, not a stub.

The Electron main process owns no business state. It spawns one `node` child per launch, kills its process tree on `window-all-closed` / `before-quit` (Windows `taskkill /T`, Unix `process.kill(-pid)`), and exposes only three window-control IPC channels (`win:minimize`, `win:toggle-maximize`, `win:close`) — no plugin graph data, no API surface. Closing the window reliably stops the backend; the `process-shutdown.ts` plugin handles its own SIGINT / SIGTERM.

The installer is ~150 MB on Windows x64 (Electron runtime ~150 MB; the backend closure is a small fraction). `dist-desktop/release/DeepSeek Harness Setup 0.1.0-rc.5.exe` is the NSIS installer; the sibling `dist-desktop/release/win-unpacked/` is a portable layout for direct execution. NSIS defaults to per-user install with no admin needed, and `allowToChangeInstallationDirectory` is on so users can pick the location.

The `dist-desktop/` directory is a build output and is not part of the published packages. The desktop shell itself is a `private: true` workspace member and is not published to npm; only the install artifacts (`dist-desktop/release/*`) are the deliverable. `dist-desktop/` should be added to `.gitignore` before the next pass.

**Compatibility shims explicitly NOT taken.** `apps/desktop/src/main.cjs` is CommonJS so the shell can stay out of the project's ESM-only source-launch contract; this is an intentional exception at the Electron boundary, not a project-wide relaxation. The Electron version is pinned to 43.4.0 because that is what the platform-specific prebuilts resolve cleanly on Windows x64; this is not a long-term floor.

## Verification

`scripts/build-desktop-backend.mjs --skip-build` produces `dist-desktop/backend/` and ends with `OK — backend served UI on :<port>` after a successful HTTP 200 poll. That exit is the GO / NO-GO signal for the packaging pipeline; if it fails, no installer is produced. Running the unpacked layout (`dist-desktop/release/win-unpacked/DeepSeek Harness.exe`) shows the same `node ... resources/backend/lib/bin.js web --port 0` child process and serves the SPA at `http://127.0.0.1:<port>/` with `<title>DeepSeek Harness</title>`. The Electron window shows the SPA with the frameless title bar; the bar's brand mark, window buttons, drag region, and theme tracking are visible without further tooling. The custom title bar's color is verified by switching the SPA's theme between light and dark and re-launching.