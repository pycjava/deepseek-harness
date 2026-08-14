# Agent Note: 桌面外壳 —— Electron 应用，将 `dsh web` 作为打包好的后端运行

Status: implemented

[English](2026-08-14-desktop-electron-app.md) | 中文

## 问题

DeepSeek Harness 的 Web UI 是主要入口面：`apps/web` 是 Vite 构建出的 SPA，`dsh web` 启动 Cordis 插件树（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`），由同一个 `node:http` 服务器同时承载 SPA 与 WebSocket / fetch 传输层。迄今运行它的方式只有两条：从代码检出里跑 `pnpm dsh web`（面向开发者），或从已安装的 npm tarball 跑 `npx @deepseek-ai/dsh web`（面向早期采用者）。两条路线都假设用户能用终端、能装 Node ≥ 22.19、且接受 UI 跑在 `http://127.0.0.1:3080/` 而不是真正的桌面应用。桌面外壳是顺理成章的下一步；可天真的实现要在"把整个 Web UI 的 React / Vite bundle 复制进外壳"和"用 IPC 桥接重新实现同源信任围栏"之间二选一——而后者恰恰是现有 HTTP + WebSocket 传输层已经实现的同一套语义。

## 决策

`apps/desktop/` 是一个薄薄的 Electron 外壳，跑现有的 `dsh web` 后端作为子进程，把 UI 加载到 BrowserWindow 里。后端绑 `127.0.0.1` 并设 `--port 0`，由 OS 选空闲端口；外壳解析就绪行、`GET /` 轮询到 200，然后 `loadURL(http://127.0.0.1:<port>/)`。SPA 由它自己的后端托管，与后端同源，所以整套 HTTP + WebSocket 传输层与 `packages/client/connection/src/api-request-trust.ts` 强制的 loopback / Origin / `sec-fetch-site` 信任围栏都原样复用——不需要重写 `WebApiClient.doFetch`，也不需要为 fetch 在 preload 里搭 IPC 桥。

主进程刻意用 CommonJS：只 import `electron` 和 Node 内置模块，从不引入 workspace 包。`apps/desktop/src/preload.cjs` 把一个无边框标题栏（鲸鱼品牌 + DeepSeek Harness 字样 + 自定义最小化 / 最大化-还原 / 关闭按钮）注入到 SPA 文档，标题栏 `-webkit-app-region: drag`、控件 `no-drag`。标题栏的 CSS 用的是 SPA 自有的 `--dsw-*` token，所以颜色跟着浅 / 深主题走，没有硬编码色板。`#root { padding-top: 36px; box-sizing: border-box }` 保证 SPA 内容不会被标题栏遮住。

桌面外壳作为 Windows NSIS 安装包发布，由 electron-builder 26 出包。Electron 主进程、preload 和 Electron 运行时走标准 `app.asar` / electron 框架。后端闭包**不**进 asar：它以 `resources/backend/` 部署，自带 `node_modules/`，显式绕过 `electron-builder` 的 `nodeGypRebuild` / `npmRebuild`（设为 `false`），让预编译的 `node-pty` / `sharp` / `koffi` addon 保持原来的 Node ABI，而不是被按 Electron ABI 重建。后端闭包由 `scripts/build-desktop-backend.mjs` 构建：`pnpm deploy` 把 `@deepseek-ai/dsh` 部署到 `dist-desktop/backend`，物化所有 staged 符号链接，然后遍历 `packages/*/*/` 与 `vendor/*/`，把每一个 workspace root peer（`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/dsh-fs`、`@deepseek-ai/dsh-timeout` 等）回填进 `node_modules`。脚本最后跑 staged 的 `node lib/bin.js web --port 0`，对 `GET /` 校验 HTTP 200 后退出。

`electron-builder` 26.x 声明 `@electron/get: ^3.0.0`，却用 `ElectronDownloadCacheMode.ReadWrite`——这个 API 要到 `@electron/get` 3.1.0 才存在；如果不约束，lockfile 会钉住 3.0.0、packager 在 `resolveCacheMode` 崩溃。修复是 workspace 级 override，写在 `pnpm-workspace.yaml`：`'@electron/get': ^3.1.0`。这是最小改动（minor bump，只增 API），其他消费方（electron 自身的 install 脚本、electron-builder 的其他传递依赖）一律不受影响。

`electron-builder` 的 `app-builder-lib` 会硬性排除任何直接位于 matcher 根下的 `node_modules` 目录（`out/util/filter.js:42-45`），无论 filter 写什么——后端闭包的 `node_modules/` 就这样被静默吃掉。修复是把 `node_modules` 作为**自己**一条 `extraResources` 的 `from` 条目，让它本身就是 matcher 根，绕过那段硬编码。

安装器按架构分发（`--arch x64|arm64`，默认 x64），可在任意宿主上交叉构建。pnpm 11 只从 workspace 设置里选平台 optional 依赖（`@img/sharp-*`、`@koromix/koffi-*`）——CLI 的 `--config.supported-architectures.*`、`NPM_CONFIG_USERCONFIG`、`npm_config_os/arch` 环境变量都被静默忽略，且普通 `pnpm install` 的 "Already up to date" 快路径不会感知设置变化——因此 `build-desktop-backend.mjs` 只在 deploy 子进程期间把 `supportedArchitectures: {os: [win32], cpu: [x64, arm64]}` 注入 `pnpm-workspace.yaml`，并在 `finally` 里恢复原文件。deploy 由此同时带上两种架构的二进制，prune 步骤只保留 `win32-<目标>`：其它架构的 prebuildify 目录（node-pty 的 `prebuilds/darwin-*`、`prebuilds/win32-arm64`）、按 `<os>-<cpu>` 目录名加 `package.json` 标记识别的平台 optional 叶子包，以及 Windows `.pdb` 调试符号（仅 node-pty 在 `prebuilds/win32-x64` 里就带约 22 MB）。x64 闭包由此从 219 MB / 17,941 个文件降到 166 MB / 17,920 个文件——node-pty 从 60 MB 降到约 3.5 MB——NSIS 安装时间与文件数和体积都成正比。`assertTargetBinaries` 随后 fail-loud：node-pty 的目标架构 prebuild、或已进闭包的 sharp / koffi 家族缺 `win32-<arch>` 变体，即视为打包缺陷报错。跨架构构建（x64 宿主打 arm64 闭包）跳过 spawn 自检：启动路径会 dlopen 目标架构 addon（koffi 从第一次会话写入起支撑 JSONL 持久化），在另一架构的宿主 node 下必然加载失败；arm64 的运行自检要在原生 arm64 硬件上跑。

## 备选方案

**`file://` 加载 + IPC fetch 桥**——否决。`webserver/src/index.ts:7-8` 已经提到这是未来 Electron 的一条路，但它要求外壳重写 `WebApiClient.doFetch` 让 SPA 能访问后端，会打破同源信任围栏（loopback `Host` 校验、`Origin` 校验、`sec-fetch-site: cross-site` 拒绝），并让 preload 变成 `api-request-trust.ts` 的重新实现。loopback HTTP 路径原样复用了一切。

**把 Node 运行时打进安装包**——否决。靠 `pkg --sea` 或复制 `node.exe` 内嵌会再加约 70 MB，要让 bundled node 与每个预编译 addon ABI 匹配，还要明文 Node 版本更新策略。要求用户机器装 Node ≥ 22.19（启动时校验，缺失友好弹窗），能让闭包二进制体积、addon ABI 与安装包大小三件事都站住。将来要做"双击安装、双击运行"的 build 时，可以再切到 bundled-node 路径，其他什么都不用改。

**Windows 上用 `pkg` 做单文件可执行**——否决。现有的 `scripts/build-exe-for-python-sdk.ts` 已经证明这条路在 Linux / macOS 走得通，但它明确标注"Windows is a documented non-goal"。为 Windows 重新推这条路超出本次范围；本决策只针对 Windows，走 electron-builder 久经考验的 NSIS 流水线。

**从外壳里用 `npx @deepseek-ai/dsh web` 启后端**——否决。这在 `pnpm` 装的开发环境里行得通，但 tarball 用户跑不动（npm install 不会把 `@deepseek-ai/dsh` 这个 bundle manifest 装成可在 resource 目录下跑的形态），也会把安装布局搞复杂。直接 `spawn('node', [resources/backend/lib/bin.js, 'web', '--port', '0'])` 两行写完，毫无歧义。

## 后果

Windows 用户能直接把 Web UI 当真正的桌面应用来用，无需终端。外壳继承完整插件运行时：bash / fs / web 工具、subagent 能力、agent 预设、`__DSH_BOOT__` 注入机制全都工作——因为 SPA 还是连真正的 `dsh web`，不是连 stub。

Electron 主进程不持有任何业务状态。每次启动 spawn 一个 `node` 子进程，`window-all-closed` / `before-quit` 时杀掉整棵进程树（Windows `taskkill /T`，Unix `process.kill(-pid)`），只暴露三个窗口控制 IPC 通道（`win:minimize`、`win:toggle-maximize`、`win:close`）——无插件图数据，无 API 表面。关窗能可靠停掉后端，`process-shutdown.ts` 插件自己处理 SIGINT / SIGTERM。

安装器在 Windows x64 上约 150 MB（Electron 运行时占大头；裁剪后的后端闭包解包 166 MB，压缩后只占零头）。`pnpm desktop:dist` 跑 `scripts/build-desktop-installer.mjs`：先按目标架构建闭包，再以对应 `--x64`/`--arm64` 标志调 electron-builder，输出到 `dist-desktop/release/<arch>/`；NSIS 产物名带架构（`DeepSeek Harness-<version>-<arch>-setup.exe`），各架构的 `win-unpacked/` 便携布局在同级目录。编排脚本用宿主 node 直调 electron-builder 的 bin 入口、绝不走 `pnpm exec`：实证发现 pnpm 11 的运行前依赖检查会在依赖状态过期时执行 `pnpm install --production`，把 workspace 的 devDependencies 剪掉并使根项目 postinstall 失败——打包路径绝不允许改动开发树。同一个检查也在仓库层面关闭（`pnpm-workspace.yaml` 里 `verifyDepsBeforeRun: false`）：`pnpm deploy`（正是本打包路线自己的 deploy 步骤）留下的依赖状态必然被它误读，检查开启时，任何 deploy 之后的第一个 pnpm 命令都会自动执行那次破坏性的生产安装。NSIS 默认按用户安装、不需管理员，并打开 `allowToChangeInstallationDirectory` 让用户自选位置。

`dist-desktop/` 是构建产物，不属于发布包的一部分。桌面外壳本身是 `private: true` 的 workspace 成员，不会发到 npm；只有安装制品（`dist-desktop/release/*`）才是交付物。下次提 PR 前应把 `dist-desktop/` 加进 `.gitignore`。

**明确不取的兼容垫片。** `apps/desktop/src/main.cjs` 是 CommonJS，让外壳能绕开项目"源码启动只 ESM"的合同；这是 Electron 边界的刻意例外，不是项目范围的放宽。Electron 版本钉在 43.4.0，因为这是 Windows x64 上平台相关 prebuild 干净解析的版本；不是长期下限。

## 验证

`scripts/build-desktop-backend.mjs --skip-build`（默认 `--arch x64`）产出 `dist-desktop/backend/` 并以 `OK — backend served UI on :<port>` 收尾，HTTP 200 校验通过。这条退出码就是打包流水线的 GO / NO-GO 信号；失败则不出安装包。在 x64 宿主上跑 `--arch arm64` 走完同一管线但跳过运行自检，闭包 `node_modules`（`node-pty/prebuilds`、`@img`、`@koromix`）里只剩 `win32-arm64` 二进制；其 spawn 自检必须在原生 arm64 硬件上跑。deploy 中途被杀的构建会在 `pnpm-workspace.yaml` 留下注入块；下次运行拒绝启动，直到 `git checkout pnpm-workspace.yaml` 清除。`pnpm desktop:dist -- --arch x64` 产出 `dist-desktop/release/x64/DeepSeek Harness-<version>-x64-setup.exe` 与同级 `win-unpacked/`。运行未打包布局能看到同样的 `node ... resources/backend/lib/bin.js web --port 0` 子进程，并在 `http://127.0.0.1:<port>/` 服务 SPA，`<title>DeepSeek Harness</title>`。Electron 窗口显示 SPA 与无边框标题栏；标题栏的品牌标识、窗口按钮、拖拽区、主题跟随这些，无需额外工具即可直接看到。标题栏颜色随 SPA 浅 / 深主题切换、然后重启来验证。