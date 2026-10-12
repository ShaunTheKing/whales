# Progress

## Current phase: 0 — Design (awaiting approval)

| Task | Owner | Status |
|---|---|---|
| Probe Cordis 4 API (isolate, effect, dispose) | orchestrator | accepted |
| `src/contracts/*.ts` interface files | orchestrator | in review (user) |
| `ARCHITECTURE.md` | orchestrator | in review (user) |
| Tooling: package.json, tsconfig, .gitignore, .env.example | orchestrator | accepted |

## Phase 1 plan — Spike (not started)

| ID | Task | Model | Depends on |
|---|---|---|---|
| 1.1 | `core/ids.ts`, `core/config.ts` + tests | chat | — |
| 1.2 | `services/store.ts` (node:sqlite) — tests first, then impl | chat ×2 | — |
| 1.3 | `services/agents.ts` (spawn/dispose/runtime/turn lock) | orchestrator writes, lifecycle-critical | 1.1 |
| 1.4 | `services/tools.ts` registry (authorize path stubbed to `approvals` contract) | orchestrator | 1.3 |
| 1.5 | `drivers/stub.ts` scripted driver (+ socket/timer effects for the dispose proof) | chat | — |
| 1.6 | `core/app.ts` createApp | chat | 1.2, 1.3 |
| 1.7 | Acceptance test + `scripts/spike.ts` demo (A vs B isolation, dispose) | tests by worker from contract; orchestrator verifies | all |

## Decisions log

- 2026-10-12 Cordis 4.0.0-rc.10, Node type stripping (no build), TS 5.9.3, `moduleResolution: Bundler`,
  `node:sqlite`. See ARCHITECTURE.md §1.
- 2026-10-12 (user) Repo: private `ShaunTheKing/whales`, push after each accepted task.
- 2026-10-12 (user) Rooms: rule `allow` is downgraded to `ask`; `deny` still denies.
- 2026-10-12 (user) Hires: lead proposes, the user approves each via the approvals queue (`agent.hire`).

## Open risks

- Cordis 4 is an RC; API may shift before 4.0. Mitigation: pinned, wrapped in core/ and agents.
- ACP adapter for Claude Code (`@zed-industries/claude-agent-acp`) is pre-1.0; evaluate in Phase 2.
- Single process: a misbehaving plugin can still block the event loop or crash all agents.

## Cost

| Phase | Orchestrator | Workers |
|---|---|---|
| 0 | design + probes (no workers used) | 0 |
