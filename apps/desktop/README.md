# DeepSeek Harness Desktop

English | [中文](README.zh.md)

Electron desktop shell for DeepSeek Harness. It boots the existing `dsh web`
backend on a loopback port chosen by the OS and loads the Web UI in a window,
so the full agent runtime and UI run locally with no protocol changes.

## Architecture

```
Electron main process (CommonJS)
 ├─ spawn → node --import tsx/esm apps/cli/src/bin.ts web --port 0
 │           └─ reads "dsh web: http://127.0.0.1:<port>" from stdout
 ├─ health-poll GET / until 200
 └─ BrowserWindow.loadURL(http://127.0.0.1:<port>/)   ← same-origin HTTP + WS
```

The Web UI is served by its own backend and is same-origin with it, so the
desktop shell reuses the entire HTTP/WebSocket transport and trust perimeter.
No `packages/` code is modified.

## Prerequisites

```sh
pnpm install
pnpm run build      # produces apps/web/dist, which `dsh web` serves
```

## Run

```sh
pnpm desktop        # = electron apps/desktop
```

The backend inherits the process environment, so provide your API key the same
way as `dsh web` — either export `DEEPSEEK_API_KEY` or place it in the repo
root `.env`.

## Package (Windows installers)

```sh
pnpm desktop:dist                      # x64 (default): backend closure + NSIS installer
pnpm desktop:dist -- --arch arm64     # arm64, cross-built on any host
node scripts/build-desktop-installer.mjs --arch x64 --skip-build   # reuse a built tree
```

Artifacts land in `dist-desktop/release/<arch>/`: the installer is named
`DeepSeek Harness-<version>-<arch>-setup.exe` next to a `win-unpacked/` layout.

The backend closure (`scripts/build-desktop-backend.mjs --arch x64|arm64`)
deploys with `supportedArchitectures` narrowed to Windows x64+arm64 — injected
into `pnpm-workspace.yaml` for the deploy only and restored right after — then
prunes every non-target binary: other architectures' `prebuilds/` dirs and
platform-optional leaves (`.pdb` debug symbols, `@img/sharp-win32-*`,
`@koromix/koffi-win32-*`). A fail-loud assert confirms the target
architecture's addons staged before packaging. Cross-arch builds skip the
spawn-and-poll self-check (target-arch addons cannot load under the host
node); run the arm64 closure's self-check on native arm64 hardware.

## Notes

- MVP: local run only. macOS/Linux installers, icons, and code signing are out
  of scope for now (next step).
- Closing the window kills the backend process tree. On Unix the backend runs
  in its own process group; on Windows the tree is killed via `taskkill /T`.
