# DeepSeek Harness 桌面版

[English](README.md) | 中文

DeepSeek Harness 的 Electron 桌面外壳。它把现有 `dsh web` 后端启动在由 OS 选择的回环端口上，并把 Web UI 加载进窗口，因此完整的 agent 运行时与 UI 都在本地运行，协议零改动。

## 架构

```
Electron main process (CommonJS)
 ├─ spawn → node --import tsx/esm apps/cli/src/bin.ts web --port 0
 │           └─ reads "dsh web: http://127.0.0.1:<port>" from stdout
 ├─ health-poll GET / until 200
 └─ BrowserWindow.loadURL(http://127.0.0.1:<port>/)   ← same-origin HTTP + WS
```

Web UI 由它自己的后端托管、与后端同源，所以桌面外壳原样复用整套 HTTP/WebSocket 传输层与信任围栏。不修改任何 `packages/` 代码。

## 前置条件

```sh
pnpm install
pnpm run build      # produces apps/web/dist, which `dsh web` serves
```

## 运行

```sh
pnpm desktop        # = electron apps/desktop
```

后端继承进程环境，所以提供 API key 的方式与 `dsh web` 相同——要么导出 `DEEPSEEK_API_KEY`，要么放进仓库根目录的 `.env`。

## 打包（Windows 安装器）

```sh
pnpm desktop:dist                      # x64 (default): backend closure + NSIS installer
pnpm desktop:dist -- --arch arm64     # arm64, cross-built on any host
node scripts/build-desktop-installer.mjs --arch x64 --skip-build   # reuse a built tree
```

产物落在 `dist-desktop/release/<arch>/`：安装器命名为 `DeepSeek Harness-<版本>-<架构>-setup.exe`，同级是 `win-unpacked/` 便携布局。

后端闭包（`scripts/build-desktop-backend.mjs --arch x64|arm64`）以 `supportedArchitectures` 收窄为 Windows x64+arm64 做 deploy——该设置只在 deploy 期间注入 `pnpm-workspace.yaml`，随后立即恢复——然后裁掉所有非目标二进制：其它架构的 `prebuilds/` 目录与平台 optional 叶子包（`.pdb` 调试符号、`@img/sharp-win32-*`、`@koromix/koffi-win32-*`）。打包前有一个 fail-loud 断言确认目标架构的 addon 在位。跨架构构建会跳过 spawn 自检（目标架构 addon 在宿主 node 下无法加载）；arm64 闭包的自检需在原生 arm64 硬件上运行。

## 说明

- MVP：仅本地运行。macOS/Linux 安装器、图标与代码签名暂不在范围内（下一步）。
- 关窗会杀掉后端进程树。Unix 上后端跑在自己的进程组里；Windows 上通过 `taskkill /T` 杀整棵树。
