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
- `profile-mcp.spec.ts` gains an explicit hscoach case asserting zero MCP resource rows (it runs no agents), instead of the shared one-row assertion every agent-bearing template carries.
- The standalone-tree contract is pinned in three places: the package's own composition spec, the HMR-absence assertion in `profile-hmr.spec.ts`, and the template pin in `app-boot`'s `profile.spec.ts`.
- The 13 MB sanitized card database ships in the package payload (`files: [data]`, allowlisted in `check-workspace-constraints`); no file-size gate exists, and the data is coverage-exempt because only `src/**/*.ts` count.
- Upstream fixture privacy forced one honest coverage regression (the CN-server end-to-end golden); everything else the upstream suite covered now runs from the repository alone, with the recovered fixture proving field-exact behavior preservation across the entire type-hardening pass.
