---
description: "Standalone Hearthstone coach application profile: one self-contained plugin row that watches Power.log, computes legal game snapshots locally, and generates turn advice over the direct DeepSeek-compatible API."
kind: "package-bundle"
---

# `@deepseek-ai/dsh-hscoach`

English | [中文](README.zh.md)

## Summary

`dsh --profile hscoach` runs the Hearthstone coach as a standalone harness application. The profile's complete tree is one self-contained plugin row: it tails the game's Power.log, computes legal visible snapshots and exact lethal damage locally, and asks a DeepSeek-compatible chat API for one recommended play per turn. Advice, game state, and win statistics are written as JSON files for the NTEToolbox overlay. The profile mounts no agents, LLM, session, or timer services — everything unneeded by the coach is absent by construction.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Launch the shipped profile; the template auto-initializes on first use. Provide the model credential through `DEEPSEEK_API_KEY` (or set `apiKey` in the profile's `cordis.patch.yml`).

```sh
dsh --profile hscoach
```

The coach starts watching Power.log immediately (`autoStart: true`). Static options — publish directory, coaching mode, API endpoint, model, watchdog timeout — resolve as explicit config keys, then environment variables, then defaults; see `resolveConfig` in [`src/index.ts`](src/index.ts). Runtime switches (`start`, `stop`, `think`, `mode`, `restore-log`, `status`) go through the `/hscoach` slash command whenever the profile also mounts a commands surface, or through the overlay's think-again button, which drops a `think-again.trigger` file into the publish directory.

The publish directory defaults to `%LOCALAPPDATA%\com.ntetoolbox.client\hscoach` (the NTEToolbox Tauri identifier directory); `DSH_HSCOACH_PUBLISH_DIR` or an explicit `publishDir` overrides it. The overlay polls `advice.json`, `game_state.json`, and `stats.json` from there. Without an API key the coach still boots and replays the previous turn's advice, marked degraded.

Before listening starts, the coach takes a single-instance lock `hscoachd.lock` in the publish directory (the file records the holder PID; a lock whose holder is dead is taken over, so crash residue self-heals). While a live instance holds the lock, startup refuses to listen and says why on the console. Builds that predate the lock ignore it and still double-record in parallel — when one game shows up twice in `history.jsonl`, look for another instance first, including old profile sessions embedded in the desktop app. The standalone tree mounts no console-logger, so lifecycle events (card database ready, watched log path, game start/end, degradation reasons) are printed to the console by the plugin itself.

Use `dsh plugin --profile hscoach` to manage persistent external dependencies on top of this tree; profile, home, and ordered `--patch` files can replace the row or insert more rows above it. The shipped template applies patches only at startup.

Running outside dsh entirely is also supported: the plugin is self-contained, so a bare Cordis root context mounts it directly. After `pnpm run build`, run `pnpm pack` on `vendor/cordis`, `vendor/cosmokit`, and this package, install the three tarballs as `file:` dependencies in a target directory, and boot with a minimal entry script — `new Context()`, `await ctx.plugin(hscoach, config)`, and signals wired to `ctx.fiber.dispose()`. Config handed to the entry resolves through the same `resolveConfig`; the single-instance lock, console output, and publish contract behave exactly as under the profile launch. The repo ships no launcher bin for this path (application launch stays a dsh-profile right).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle's single insert is the complete application tree: one row mounting the bundle's own package. The plugin is a Cordis function plugin whose runtime keeps zero host-package imports — host types are `import type` only — so the row activates in any tree that can load the package. It owns its lifecycle through `ctx.effect` and a global polling interval, and registers `/hscoach` through a lazy `ctx.inject(['commands'])` that stays inert when no commands service exists.

The deterministic core is pure local computation: a Power.log parser over the sanitized bundled card database, an incremental turn detector, a serializer that enforces hidden-information legality in code (opponent hands expose a count only; a tagged hand entity aborts serialization), and a conservative lethal solver (0-1 knapsack over the mana budget plus subset-sum taunt clearing — under-reporting over ever fabricating lethal). Advice generation is one direct `chat/completions` call with JSON output and a watchdog; the model output is field-validated before it reaches the publish contract.

### Source map

| File | Role |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Complete standalone profile tree and its neutral defaults |
| [`src/index.ts`](src/index.ts) | Plugin entry: config resolution, orchestration, command handling |
| [`src/core/`](src/core/) | Deterministic core: parser, entities, state serialization, lethal, tail, history |
| [`src/advice/`](src/advice/) | Direct-API advice provider and coach prompts |
| [`src/runtime/engine.ts`](src/runtime/engine.ts) | Coaching engine: batching, turn triggers, latest-wins publication |
| [`src/runtime/lock.ts`](src/runtime/lock.ts) | Publish-directory single-instance lock: PID liveness, stale-lock self-healing |
| [`data/`](data/) | Bundled sanitized HearthstoneJSON card database (zhCN) |
| — | No runtime invariant companion is published; the single inserted row owns its own runtime relationships, and independent observations cannot diverge from the deterministic core it alone computes. |
| [`tests/parity.spec.ts`](tests/parity.spec.ts) | Golden-snapshot regression pin over the bundled game log |
| [`tests/hscoach.spec.ts`](tests/hscoach.spec.ts) | Exact composition and standalone-tree checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Base bundle](../base/README.md) — the full product foundation this standalone profile deliberately omits.
- [SDK-minimal bundle](../sdk-minimal/README.md) — the other shipped standalone single-bundle profile.
- [app-boot](../../boot/app-boot/README.md) — how profiles are resolved, layered, and customized.

-----

<a id="model-experience"></a>
## Model Experience

None, as the profile runs no harness agent and logs no session; the coach's own direct DeepSeek-compatible calls never enter model requests or Session events.

#### KV Cache effect

Stable: the profile mounts exactly one row with fixed default config, and no content of its own enters any model cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No interactive surface ships in the tree** — the `/hscoach` command activates only when a commands surface is layered on top; out of the box the control channels are the think-again trigger file and profile restarts.
- **Advice degrades without a reachable API** — a missing key or a timed-out request republishes the previous turn's advice marked degraded instead of generating a new one.
- **The golden parity suite carries one fixture** — the upstream second fixture (a CN-server two-game log) was never committed by its author and could not be migrated; CN-server quirks (duplicate PowerTaskList CREATE_GAME, nickname mapping) rely on the parser's unit coverage rather than a frozen end-to-end golden.
- **Game discovery is Windows-shaped** — Hearthstone install detection queries the Windows registry and `%LOCALAPPDATA%`; the parser itself is platform-neutral, but a non-Windows machine must point `resolveLogPath` at a log explicitly to be useful.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plugin is a port of [pycjava/dsh-hscoach](https://github.com/pycjava/dsh-hscoach) at commit `c3c4f27`, reshaped to repository conventions: real `@deepseek-ai/cordis` and `@deepseek-ai/dsh-commands` types replace the upstream ambient host stub, and all regex-capture and record-index reads carry explicit undefined guards (`noUncheckedIndexedAccess`). The parity fixture `friendly_player_id_is_1.power.log` was recovered from the NTEToolbox repository history (already sanitized — no real player names).

</details>
