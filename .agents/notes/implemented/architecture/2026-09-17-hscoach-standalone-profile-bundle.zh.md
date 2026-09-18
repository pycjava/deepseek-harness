# Agent Note: 炉石教练成为 hscoach 独立 profile 组合包

Status: implemented

[English](2026-09-17-hscoach-standalone-profile-bundle.md) | 中文

## Problem

炉石教练（[pycjava/dsh-hscoach](https://github.com/pycjava/dsh-hscoach)）完全位于本仓库之外：一个自包含的 Cordis 函数插件，经 `dsh plugin --profile <name> add <path>` 逐 profile 安装。把它当应用运行意味着把插件叠在 `dsh-base` 之上——那会挂载约四十条教练从不使用的配置行（agents、LLM 服务、session、typert、web 工具），而且上游仓库自己的测试套件在干净检出上无法运行：Power.log fixture 是被 gitignore 的私有文件（全新克隆上 20 个测试挂 14 个）。

## Decision

教练以 `@deepseek-ai/dsh-hscoach` 落在 `packages/bundle/hscoach/`，沿用 `sdk-minimal` 的独立 bundle 形态：包声明 `dsh.bundle.patch`，单次 insert 即完整应用树——恰好一行装载 bundle 自身的包，`verify-cordis-config` 对此明确豁免（"a bundle may mount its own package"）。`PROFILE_TEMPLATES` 新增 shipped `hscoach` 模板（bundles: `['@deepseek-ai/dsh-hscoach']`，仅启动时应用 patch），`dsh --profile hscoach` 随之自动初始化；`apps/cli` 将该包纳为内置 bundle 依赖，双锚点解析始终从安装内供包。

移植把源码提升到仓库类型标准而非保留上游的环境宿主桩：真实的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-commands` 类型（全部 `import type`，运行期仍零宿主包导入）、所有正则捕获组与记录索引读取的 undefined 守卫（`noUncheckedIndexedAccess`）、`exactOptionalPropertyTypes` 合规的可选属性管道，以及运行期验证的 `toAdvice` 边界（模型 JSON 输出逐字段收窄，同时保留上游测试钉死的标量强制转换语义）。

对拍 fixture `friendly_player_id_is_1.power.log` 从 NTEToolbox 仓库历史找回（已脱敏——无真实玩家名），冻结的黄金对比得以在干净检出上运行。上游第二份 golden（`cn_server_two_games.power.golden.json`）连同其测试用例一并移除：其源日志从未在任何仓库提交过，无法迁移；它覆盖的国服怪癖仍由 parser 处理，并作为限制记录在案。

## Alternatives considered

- **保持插件外部化，以 git 依赖引用** —— pnpm 会克隆一个没有 `prepare` 脚本的包，因此没有 `lib/`；每次 workspace 安装都依赖网络；且仓库刻意不为每种部署形态持有配置行（见 [profile-bundles 决策](2026-08-05-profile-plugin-bundles.zh.md)）。否决。
- **在 `vendor/` 下落源码** —— vendoring 保留给 Cordis 框架层并会重设包身份；教练是应用而非框架依赖。否决。
- **放在 `packages/experimental/`** —— `verify-default-product-isolation` 拒绝 experimental 包进入 `PROFILE_TEMPLATES`，且 bundle 组才是独立应用 bundle 的归属（`sdk-minimal` 先例）。否决。
- **像模式 bundle 一样把教练叠在 `dsh-base` 上** —— 教练不需要任何 base 服务（其建议调用按设计绕过宿主 agents 服务）；base 支撑的树会挂载应用用不到的每一行，与裁剪目标相悖。否决。

## Consequences

- `dsh --profile hscoach` 启动单行应用：无 agents、无 LLM 宿主服务、无 session、无 timer 插件——常驻进程靠教练自身的轮询定时器保活，并经标准有界信号路径关闭。
- `profile-mcp.spec.ts` 新增显式 hscoach 用例，断言零 MCP 资源行（它不运行 agents），取代每个承载 agent 的模板共享的"恰好一行"断言。
- 独立树契约在三处钉死：包自身的组合测试、`profile-hmr.spec.ts` 的无 HMR 断言、`app-boot` 的 `profile.spec.ts` 模板钉。
- 13 MB 脱敏卡牌数据库随包载荷发布（`files: [data]`，已在 `check-workspace-constraints` 白名单）；不存在文件大小门禁，数据不参与覆盖率（只有 `src/**/*.ts` 计入）。
- 上游 fixture 的隐私性迫使一次诚实的覆盖回退（国服端到端 golden）；上游套件覆盖的其余一切现在仅凭仓库即可运行，找回的 fixture 证明了整轮类型加固全程保持逐字段一致的行为。

## 后续：单实例锁与控制台反馈（2026-09-18）

真实 Windows 机器上的实跑暴露两个运维缺口。其一，独立树不向控制台打印任何内容（无 console-logger 行），用户看不出应用已启动，一分钟后又开了一份。其二，并发的教练实例共享发布目录的 `history.jsonl`/`stats.json`，每局重复记账；实跑排查把其中一个记账者定位到另一处安装的桌面版内嵌旧 hscoach profile 会话——旧代码天然不读锁，这正是锁必须在控制台上大声拒绝、而不是静默继续的原因。

- `src/runtime/lock.ts` 以 `open(path, 'wx')` 原子创建抢占发布目录的 `hscoachd.lock`；锁内记录的 PID 存活（signal 0 探测，EPERM 视为存活）时拒绝启动，持有者已死或内容损坏则删除重试，崩溃残留自愈。文件名刻意沿用 NTEToolbox 原版守护进程的锁名，升级后无缝接管。同进程内第二个实例同样拒绝：PID 相同不代表同一实例。
- 插件把生命周期事件直接桥接到控制台（`[hscoach HH:mm:ss]` 行：卡牌库就绪、监听路径、对局开始/结束、降级原因）。这棵树里 `ctx.logger` 没有接收端；插件即应用，控制台话语权归它。告警同时保留 `ctx.logger.warn` 通道供宿主侧诊断。
- `hscoach stop` 与 tail 崩溃都释放锁（tail 崩溃不释放会把进程锁在自己的重启之外）；`start` 先等待上一次释放落定再重新抢占，stop/start 循环不会撞上自己的 unlink。
- 锁冲突拒绝经 `/hscoach start` 返回错误、autoStart 启动时打印控制台告警；应用保持存活但不监听。
- 同一场实跑还暴露了 tail 的幻影记账路径：被监听的时间戳目录被删除后，路径解析回退到更旧的日志，切换时会把旧文件从头重读——旧对局被重新记入 `history.jsonl`。现在 tail 仅在解析到的文件比上次消费的文件更新（新对局目录）时才从头读；回退到更旧的文件（日志清理）从末尾续读，不重放任何对局。

## 后续：独立 Cordis 部署与打包产物的卡牌库定位修复（2026-09-19）

教练现在可以作为自己的 harness 运行，完全不涉及 dsh CLI、桌面版或 `~/.dsh`：三个本地 tarball（`vendor/cordis`、`vendor/cosmokit`、bundle 包）以 `file:` 依赖安装，外加一个极简入口——创建裸 `Context`、直挂插件函数、信号接到 `ctx.fiber.dispose()`。筹备该部署暴露了一个只有安装产物才会踩中的缺陷：`defaultDataDirs` 按模块上跳两级计算包根，对 `src/core/` 正确，对 tsdown 打平的 `lib/index.js` 多跳了一级——每个 packed-tarball 消费者都找不到卡牌数据库；源码启动和 dsh CLI 从不走打包产物，所以从未暴露。

- `dataDirsFor(moduleUrl)` 现在同时返回源码布局与打包布局的包根，按存在性依次尝试（机制不变）；`defaultDataDirs` 以 `import.meta.url` 委托。
- 在安装产物上端到端验证：卡牌库从打包副本加载（35713 张）；对存活持有者锁拒绝；持有者死亡后锁接管；演示对局每个发布产物恰好写一份；think-again 触发文件被消费；删除演示目录后零重放。profile 启动路径未变。
- 独立部署是包的消费者，不是仓库面：仓库不为它提供 bin（应用启动权仍归 dsh profile）；bundle README 记录了 pack-and-mount 配方。
