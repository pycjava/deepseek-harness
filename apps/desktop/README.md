# DeepSeek Harness Desktop

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

## Notes

- MVP: local run only. Cross-platform installers, icons, code signing, and an
  embedded Node runtime are out of scope for now (next step).
- Closing the window kills the backend process tree. On Unix the backend runs
  in its own process group; on Windows the tree is killed via `taskkill /T`.
