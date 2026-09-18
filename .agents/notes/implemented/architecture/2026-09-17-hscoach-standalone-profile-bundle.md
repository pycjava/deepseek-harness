# Agent Note: The Hearthstone coach becomes the hscoach standalone profile bundle

Status: implemented

English | [中文](2026-09-17-hscoach-standalone-profile-bundle.zh.md)

## Problem

The Hearthstone coach ([pycjava/dsh-hscoach](https://github.com/pycjava/dsh-hscoach)) lived entirely outside this repository: a self-contained Cordis function plugin installed per profile through `dsh plugin --profile <name> add <path>`. Running it as an application meant layering the plugin over `dsh-base`, which mounts roughly forty rows the coach never touches — agents, LLM services, sessions, typert, web tooling — and the upstream repository's own test suite could not run from a clean checkout because its Power.log fixtures were gitignored private files (14 of 20 tests failed on a fresh clone).

## Decision

The coach ships as `@deepseek-ai/dsh-hscoach` in `packages/bundle/hscoach/`, following the `sdk-minimal` standalone-bundle shape: the package declares `dsh.bundle.patch`, and its single insert is the complete application tree — exactly one row mounting the bundle's own package, which `verify-cordis-config` explicitly exempts from the bundle-dependency rule ("a bundle may mount its own package"). A shipped `hscoach` template in `PROFILE_TEMPLATES` (bundles: `['@deepseek-ai/dsh-hscoach']`, startup-only patch reload) makes `dsh --profile hscoach` auto-initialize, and `apps/cli` carries the package as an in-box bundle dependency so two-anchor resolution always serves it from the installation.

The port brings the source to repository type standards instead of keeping the upstream's ambient host stub: real `@deepseek-ai/cordis` and `@deepseek-ai/dsh-commands` types (all `import type`, so the runtime still imports zero host packages), undefined guards on every regex-capture and record-index read (`noUncheckedIndexedAccess`), `exactOptionalPropertyTypes`-clean optional plumbing, and a runtime-validated `toAdvice` boundary (model JSON output is narrowed field by field, keeping the upstream's scalar-coercion semantics that its tests pin).

The parity fixture `friendly_player_id_is_1.power.log` was recovered from the NTEToolbox repository history (already sanitized — no real player names) so the frozen golden comparison runs from a clean checkout. The second upstream golden (`cn_server_two_games.power.golden.json`) was dropped with its test case: its source log was never committed anywhere and cannot be migrated; the CN-server quirks it covered remain handled by the parser and are noted as a limitation.

## Alternatives considered

- **Keep the plugin external and reference it by git dependency** — pnpm would clone a package without a `prepare` script and therefore without `lib/`, every workspace install would depend on network access, and the repository deliberately holds no row per deployment shape (the [profile-bundles decision](2026-08-05-profile-plugin-bundles.md)). Rejected.
- **Vendor the source under `vendor/`** — vendoring is reserved for the Cordis framework layer and rescopes package identities; the coach is an application, not a framework dependency. Rejected.
- **Place the package under `packages/experimental/`** — `verify-default-product-isolation` rejects experimental packages in `PROFILE_TEMPLATES`, and the bundle group is where standalone application bundles live (`sdk-minimal` precedent). Rejected.
- **Layer the coach over `dsh-base` like the mode bundles** — the coach needs no base service (its advice calls bypass the host agents service by design); a base-backed tree would mount every row the application does not use, contradicting the trimming goal. Rejected.

## Consequences

- `dsh --profile hscoach` boots a one-row application: no agents, no LLM host service, no sessions, no timer plugin — the daemon stays alive through the coach's own polling interval and shuts down through the standard bounded signal path.
- profile-mcp.spec.ts gains an explicit hscoach case asserting zero MCP resource rows (it runs no agents), instead of the shared one-row assertion every agent-bearing template carries.
- The standalone-tree contract is pinned in three places: the package's own composition spec, the HMR-absence assertion in `profile-hmr.spec.ts`, and the template pin in `app-boot`'s `profile.spec.ts`.
- The 13 MB sanitized card database ships in the package payload (`files: [data]`, allowlisted in `check-workspace-constraints`); no file-size gate exists, and the data is coverage-exempt because only `src/**/*.ts` count.
- Upstream fixture privacy forced one honest coverage regression (the CN-server end-to-end golden); everything else the upstream suite covered now runs from the repository alone, with the recovered fixture proving field-exact behavior preservation across the entire type-hardening pass.

## Follow-up: single-instance lock and console feedback (2026-09-18)

A live run on a real Windows machine exposed two operational gaps. First, nothing in the standalone tree prints to the console (no console-logger row), so a user could not tell the app had booted and started a second copy a minute later. Second, concurrent coach instances share the publish directory's `history.jsonl`/`stats.json` and double-record every game; the live investigation traced one recorder to an old hscoach profile session embedded in a separately installed desktop build — old code ignores locks by construction, which is exactly why the lock had to fail loud on the console instead of silently proceeding.

- `src/runtime/lock.ts` takes `hscoachd.lock` in the publish directory with `open(path, 'wx')` atomic create; an existing lock whose recorded PID is alive (signal-0 probe, EPERM counts as alive) refuses startup, and a dead or corrupt lock is unlinked and retried so crash residue self-heals. The filename deliberately matches the original NTEToolbox daemon's lock so an upgrade takes over seamlessly. Same-process second instances are refused too: an identical PID does not identify the same instance.
- The plugin bridges lifecycle events to the console directly (`[hscoach HH:mm:ss]` lines: card database ready, watched log path, game start/end, degradation reasons). `ctx.logger` alone has no sink in this tree; the plugin is the application, so it owns its console voice. Warnings keep the `ctx.logger.warn` channel for host-side diagnostics.
- `hscoach stop` and a crashed tail both release the lock (a tail crash without release would lock the process out of its own restart); `start` awaits the previous release before re-acquiring so a stop/start cycle cannot collide with its own unlink.
- Lock-conflict refusals return an error through `/hscoach start` and a console warning on autoStart boot; the app stays up without tailing.
- The same live run exposed a phantom-record path in the tail: when the watched timestamped directory is deleted, path resolution falls back to an older log, and the switch re-read that file from the head — re-recording old games into `history.jsonl`. The tail now reads from the head only when the resolved file is newer than the last consumed file (a new game directory); falling back to an older file (log cleanup) resumes from the end and replays nothing.

## Follow-up: standalone Cordis deployment and bundled-artifact data fix (2026-09-19)

The coach now runs as its own harness with no dsh CLI, desktop app, or `~/.dsh` involvement: three local tarballs (`vendor/cordis`, `vendor/cosmokit`, the bundle package) installed as `file:` dependencies, plus a minimal entry that creates a bare `Context`, mounts the plugin function directly, and wires signals to `ctx.fiber.dispose()`. Preparing that deployment exposed a defect only installed artifacts can hit: `defaultDataDirs` computed the package root two levels above the module, correct for `src/core/` but one level too deep for the tsdown-bundled `lib/index.js`, so every packed-tarball consumer failed to find the card database — source launches and the dsh CLI never exercise the bundle.

- `dataDirsFor(moduleUrl)` now returns both the source-layout and bundled-layout package roots, tried by existence as before; `defaultDataDirs` delegates with `import.meta.url`.
- Verified end-to-end on the installed artifact: card database loads (35,713 entries) from the packed copy; lock refusal against a live holder; stale-lock takeover after the holder died; a demo game wrote every publish artifact exactly once; the think-again trigger was consumed; removing the demo directory replayed nothing. The profile launch path is unchanged.
- The standalone deployment is a package consumer, not a repo surface: the repo ships no bin for it (application launch stays a dsh-profile right); the bundle README documents the pack-and-mount recipe.
