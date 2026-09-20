---
description: "独立炉石教练应用 profile：单个自包含插件行，监听 Power.log、本地计算合法局面快照，并经直连 DeepSeek 兼容 API 生成出牌建议。"
kind: "package-bundle"
---

# `@deepseek-ai/dsh-hscoach`

[English](README.md) | 中文

## 概述

`dsh --profile hscoach` 把炉石教练作为独立的 harness 应用运行。该 profile 的完整树是单个自包含插件行：监听游戏的 Power.log，本地计算合法可见快照与精确斩杀伤害，并调用 DeepSeek 兼容对话 API 为每个回合生成一条主推荐。建议、对局状态与胜负统计以 JSON 文件写出，供 NTEToolbox 悬浮窗消费。该 profile 不装载 agents、LLM、session、timer 等任何教练用不到的服务。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

直接启动 shipped profile；模板在首次使用时自动初始化。通过 `DEEPSEEK_API_KEY`（或在 profile 的 `cordis.patch.yml` 里设置 `apiKey`）提供模型凭据。

```sh
dsh --profile hscoach
```

教练随即开始监听 Power.log（`autoStart: true`）。静态选项——发布目录、教练模式、API 端点、模型、watchdog 超时——按"显式配置键 > 环境变量 > 默认值"解析，见 [`src/index.ts`](src/index.ts) 中的 `resolveConfig`。运行时开关（`start`、`stop`、`think`、`mode`、`restore-log`、`status`）走 `/hscoach` 斜杠命令（仅当 profile 叠加了 commands 交互面时可用），或走悬浮窗的"再想想"按钮——它在发布目录写入 `think-again.trigger` 文件。

发布目录默认为 `%LOCALAPPDATA%\com.ntetoolbox.client\hscoach`（NTEToolbox 的 Tauri identifier 目录）；`DSH_HSCOACH_PUBLISH_DIR` 或显式 `publishDir` 可覆盖。悬浮窗从该目录轮询 `advice.json`、`game_state.json`、`stats.json`。没有 API key 时教练仍可启动，并回显上一回合建议（标记降级）。

启动监听前会在发布目录抢占单实例锁 `hscoachd.lock`（内容为持有者 PID；持有者进程已死则自动接管，崩溃残留自愈）。锁被存活实例持有时，本次启动拒绝监听并在控制台说明原因。早于锁机制的旧构建不读锁，与其并行仍会重复记录——发现同一局在 `history.jsonl` 出现两条记录时，先排查其他实例（含桌面版内嵌的旧 profile 会话）。独立树不装载 console-logger，生命周期事件（卡牌库就绪、监听路径、对局开始/结束、降级原因）由插件直接打印到控制台。

用 `dsh plugin --profile hscoach` 在这棵树之上管理持久外部依赖；profile、home 与有序的 `--patch` 文件可以替换该行或在它上方插入更多行。shipped 模板仅在启动时应用补丁。

也支持完全脱离 dsh 运行：插件自包含，裸 Cordis 根上下文即可直挂。`pnpm run build` 后对 `vendor/cordis`、`vendor/cosmokit` 与本包各执行 `pnpm pack`，把三个 tarball 以 `file:` 依赖装进目标目录，再用一个极简入口启动——`new Context()`、`await ctx.plugin(hscoach, config)`，信号接到 `ctx.fiber.dispose()`。交给入口的配置同样经 `resolveConfig` 解析；单实例锁、控制台输出与发布契约和 profile 启动完全一致。仓库不为该路径提供启动 bin（应用启动权仍归 dsh profile）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

bundle 的单次 insert 就是完整应用树：一行装载 bundle 自身所在的包。插件是 Cordis 函数插件，运行期保持零宿主包导入——宿主类型全部 `import type`——因此该行在任何能加载本包的树中都可激活。生命周期由 `ctx.effect` 与全局轮询定时器掌管；`/hscoach` 经惰性 `ctx.inject(['commands'])` 注册，commands 服务缺席时保持静默。

确定性核心是纯本地计算：基于内置脱敏卡牌数据库的 Power.log 解析器、增量回合探测器、代码级强制隐藏信息合法性的序列化层（对手手牌只暴露数量；带标签的手牌实体中止序列化），以及保守的斩杀求解器（法力预算上的 0-1 背包 + 清嘲讽子集和——宁可漏报也绝不谎报斩杀）。建议生成是一次直连 `chat/completions` 调用（JSON 输出 + watchdog）；模型输出逐字段验证后才进入发布契约。可选宿主服务 `hscoachChatContext` 会把最近的玩家-教练对话注入每回合建议的 prompt（独立入口的网页聊天提供该服务；dsh profile 挂载时缺席，注入关闭）。

复盘（重放）复用同一套管线而不复制它：`src/replay/` 把一份历史 Power.log 按 CREATE_GAME 与回合边界切成批次（`splitter.ts`），逐批喂给一个**自建引擎**并 `await idle()` 等建议落定——整份日志一次性灌入会被 latest-wins 作废中间回合，只有按回合等待才能让每个友方回合真正拿到建议。快进区间与"确实无动作"的回合（`trivial.ts`：无斩杀、无可用手牌、无攻击频率、英雄技能也不可用）不调用模型；同一「局面 + 模型 + 模式」的调用结果按哈希落盘缓存（`cache.ts`），因此换模式重看是真实调用、同配置重看是零成本。重放引擎的发布目录指到独立目录，与实时监听并存且互不污染；每轮重放独立存档（`games/<会话>__g<n>/runs/<轮次>/`：turns.jsonl + review.md + meta.json），同局重跑互不覆盖，终局后据逐回合档案生成一份赛后总结（`review.ts`）。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 完整独立 profile 树及其中性默认值 |
| [`src/index.ts`](src/index.ts) | 插件入口：配置解析、编排、命令处理 |
| [`src/core/`](src/core/) | 确定性核心：解析器、实体、状态序列化、斩杀、tail、战绩 |
| [`src/advice/`](src/advice/) | 直连 API 建议生成器与教练 prompt；`chatCompletion.ts` 统一处理超时、非 200 与推理截断重试 |
| [`src/runtime/engine.ts`](src/runtime/engine.ts) | 教练引擎：批处理、回合触发、latest-wins 发布 |
| [`src/runtime/lock.ts`](src/runtime/lock.ts) | 发布目录单实例锁：PID 存活检测、陈旧锁自愈 |
| [`src/replay/`](src/replay/) | 复盘（重放）：按回合切批、快进/琐碎回合跳过、建议缓存、赛后总结 |
| [`src/core/logScan.ts`](src/core/logScan.ts) | 历史 Power.log 扫描：列出可复盘对局（职业/回合/胜负） |
| [`data/`](data/) | 内置脱敏 HearthstoneJSON 卡牌数据库（简中） |
| — | 未发布运行期 invariant 伴随包；唯一的插入行拥有自己的运行期关系，且独立观测不可能偏离它独自计算的确定性核心。 |
| [`tests/parity.spec.ts`](tests/parity.spec.ts) | 基于内置对局日志的黄金快照回归钉 |
| [`tests/hscoach.spec.ts`](tests/hscoach.spec.ts) | 精确组合与独立树检查 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Base bundle](../base/README.zh.md) —— 本独立 profile 刻意省略的完整产品底座。
- [SDK-minimal bundle](../sdk-minimal/README.zh.md) —— 另一个 shipped 的单 bundle 独立 profile。
- [app-boot](../../boot/app-boot/README.zh.md) —— profile 如何被解析、分层与定制。

-----

<a id="model-experience"></a>
## 模型体验

无。该 profile 不运行任何 harness agent、不记录 session；教练自身的直连 DeepSeek 兼容调用从不进入模型请求或 Session 事件。

#### KV 缓存影响

稳定：该 profile 只挂载一行固定默认配置的插件，自身没有任何内容进入模型缓存。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **树内不随附交互面** —— `/hscoach` 命令仅在上方叠加 commands 交互面时激活；开箱即用的控制通道是再想想触发文件与 profile 重启。
- **API 不可达时建议降级** —— key 缺失或请求超时会回显上一回合建议并标记降级，而非生成新建议。
- **黄金对拍套件只有一份 fixture** —— 上游第二份 fixture（国服双局日志）从未被作者提交，无法迁移；国服怪癖（PowerTaskList 重复 CREATE_GAME、昵称映射）依赖解析器的单元测试而非冻结的端到端 golden。
- **游戏发现面向 Windows** —— 炉石安装探测查询 Windows 注册表与 `%LOCALAPPDATA%`；解析器本身平台中立，但非 Windows 机器需显式指定日志路径才有意义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本插件移植自 [pycjava/dsh-hscoach](https://github.com/pycjava/dsh-hscoach)（commit `c3c4f27`），并按仓库规范重塑：真实的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-commands` 类型取代上游的环境宿主桩；所有正则捕获组与记录索引读取带显式 undefined 守卫（`noUncheckedIndexedAccess`）。对拍 fixture `friendly_player_id_is_1.power.log` 从 NTEToolbox 仓库历史找回（已脱敏——无真实玩家名）。

</details>
