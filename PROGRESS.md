# Progress

## Current phase: 2 — Headless usable (in progress). Phase 1 ✅ accepted 2026-10-12.

### Phase 1 tasks

| ID | Task | Who | Status |
|---|---|---|---|
| 1.1 | `core/ids.ts`, `core/config.ts` | tests: DeepSeek chat · impl: DeepSeek chat | accepted (2 test bugs fixed by orchestrator) |
| 1.2 | `services/store.ts` (node:sqlite) | tests: DeepSeek chat · impl: DeepSeek chat | accepted (1 test bug fixed: null-prototype rows) |
| 1.3 | `services/agents.ts` (spawn/dispose/restore, runtime, turn lock) | orchestrator | accepted; worker tests found 2 real bugs (history order, `busy` while queued), fixed |
| 1.4 | `services/tools.ts` registry + fail-closed permission gate | orchestrator | accepted |
| 1.5 | `drivers/stub.ts` | tests: DeepSeek chat · impl: DeepSeek chat | accepted (`#private` → `private`: Cordis proxies) |
| 1.6 | `services/store-service.ts`, `core/app.ts` | orchestrator | accepted |
| 1.7 | `test/phase1.acceptance.test.ts` | DeepSeek reasoner (failed: spent budget thinking) → chat | accepted; mutation-tested |
| 1.8 | `test/services/agents.test.ts`, `tools.test.ts` | DeepSeek chat, from contracts | accepted |
| 1.9 | `scripts/spike.ts` real-process demo | DeepSeek chat | accepted (counter plumbing + field name fixed) |

### Phase 1 evidence
- `pnpm typecheck` clean · `pnpm test` 156/156 · `pnpm spike` 28/28 checks, exits 0 on its own (no leaked handles).
- Mutation check: removing `isolate()` fails all 6 acceptance tests; removing the dispose hook fails exactly
  "disposing A tears down only A".

## Phase 2 — Headless usable (user priority: openai-compat driver first)

| ID | Task | Who | Status |
|---|---|---|---|
| 2.1 | `drivers/openai-compat.ts` (DeepSeek/OpenAI/OpenRouter/Ollama, SSE streaming) | tests: DeepSeek chat · impl: DeepSeek chat · stream parser rewritten + security hardening by orchestrator | accepted (mock only) |
| 2.2 | `scripts/live-check.ts` (one real round-trip, 64-token cap) | orchestrator | accepted against local mock; **live call awaiting user OK** |
| 2.3 | rules, approvals | orchestrator | todo |
| 2.4 | memory, skills, routines, CLI | workers | todo |
| 2.5 | driver-acp (Claude Code) | needs dependency approval | todo |

2.1 review notes: worker left an undeclared variable and a duplicated handler block; the idle timer was never reset
while streaming (any reply > 60 s would have been cut off) — not caught by the worker's tests, fixed and
regression-tested (mutation-checked). Added: one redaction choke point for every error, `redirect: 'error'`
(no Authorization header to another host), bounded error-body reads.

## Decisions log

- 2026-10-12 Cordis 4.0.0-rc.10, Node type stripping (no build), TS 5.9.3, `moduleResolution: Bundler`,
  `node:sqlite`. See ARCHITECTURE.md §1.
- 2026-10-12 (user) Repo: private `ShaunTheKing/whales`, push after each accepted task.
- 2026-10-12 (user) Rooms: rule `allow` is downgraded to `ask`; `deny` still denies.
- 2026-10-12 (user) Hires: lead proposes, the user approves each via the approvals queue (`agent.hire`).
- 2026-10-12 `AgentRuntime.busy` = queued or running (contract wording updated).
- 2026-10-12 `defaults.cheapDriver` in whales.config.json replaces the default as a whole (no deep merge).

## Open risks

- Cordis 4 is an RC; API may shift before 4.0. Mitigation: pinned, wrapped in core/ and agents.
- Cordis rules that bit workers (inject, proxies vs `#private`, PENDING fibers resolving) are now in
  ARCHITECTURE.md §9 and must be pasted into every brief that touches Cordis.
- If a consumer abandons `turn()` mid-stream, `whales/turn-after` does not fire (lock is released). Checkpoints (P5) must tolerate it.
- A plugin that fails *after* startup does not change `AgentHandle.state` yet.
- ACP adapter for Claude Code (`@zed-industries/claude-agent-acp`) is pre-1.0; evaluate in Phase 2.
- Single process: a misbehaving plugin can still block the event loop or crash all agents.

## Cost (approximate)

| Phase | Orchestrator | DeepSeek workers |
|---|---|---|
| 0 | design + probes | 0 |
| 1 | review, 4 Cordis probes, agents/tools/app (~350 lines) | 11 calls, ~102k tokens (~45k in / ~57k out; 21k wasted by the reasoner retry) |
| 2 (so far) | spec, stream-parser rewrite, security review, live-check | 2 calls, ~36k tokens |
