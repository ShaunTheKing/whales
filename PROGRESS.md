# Progress

## Current phase: 4 — Server + web UI ✅ accepted 2026-10-12. Next: Phase 5 — Polish (awaiting go-ahead).

Phases 1–3 ✅ accepted 2026-10-12 (task tables in git history). driver-acp still parked (needs dependency approval).

### Phase 4 tasks

| ID | Task | Who | Status |
|---|---|---|---|
| 4.1 | `server/security.ts`, `server/events.ts`, `server/server.ts`, `whales serve` | orchestrator; 35 adversarial tests by DeepSeek | accepted (host/origin/token guards mutation-checked; 413 now closes the connection) |
| 4.2 | `server/api.ts` REST + NDJSON streaming | DeepSeek tests + impl | accepted (DELETE wiped history without ?forget; conflict codes) |
| 4.3 | Reject secret-looking values in agent specs | orchestrator | accepted |
| 4.4 | `web/src/api.ts`, `types.ts` (token handling, streaming client) | orchestrator | accepted |
| 4.5 | UI shell (App, Sidebar, forms, styles) / views (chat, room, tools, approvals) | 2 DeepSeek workers in parallel | accepted after live fixes |

### Phase 4 evidence
- `pnpm typecheck` clean · `pnpm test` 528/528 · `pnpm --filter whales-web build` (≈75 KB gzip) · `pnpm spike` 28/28.
- Built-in browser against `whales serve`, three live DeepSeek agents: token taken from the fragment and stripped; room round
  streamed with Cora arbitrating; DM → `write_file` → approval card with content preview → Allow once → STYLE.md written in
  her workspace; tool box and usage kept after the turn; restarted server rejected the old token (token screen shown).

### Bugs found only by the live browser run (all fixed)
- `serve` still installed the terminal approval prompt; with no stdin it denied every request in 2 ms (audit trail shows it).
- Finished DM turns were replaced by text-only history, so tool calls vanished; arbiter badge missing in room history.
- Text before/after a tool call ran together; a new `#token=` link in an open tab was ignored until reload.

### Known gaps (Phase 4)
- Tool calls inside room turns are not kept after the round ends (text is).
- No per-user accounts: one token = full control (single-user, local-first by design).

## Decisions log

- 2026-10-12 Cordis 4.0.0-rc.10, Node type stripping (no build), TS 5.9.3, `moduleResolution: Bundler`,
  `node:sqlite`. See ARCHITECTURE.md §1.
- 2026-10-12 (user) Repo: private `ShaunTheKing/whales`, push after each accepted task.
- 2026-10-12 (user) Rooms: rule `allow` is downgraded to `ask`; `deny` still denies.
- 2026-10-12 (user) Hires: lead proposes, the user approves each via the approvals queue (`agent.hire`).
- 2026-10-12 `AgentRuntime.busy` = queued or running (contract wording updated).
- 2026-10-12 Server: `ws` instead of `@hono/node-ws` (peer-dep conflict); token always required, even on loopback.
- 2026-10-12 Agent specs may not contain secret values (same rule as whales.config.json).
- 2026-10-12 Hires get unique ids AND display names; hire approval uses strict mode (allow rules cannot skip the human).
- 2026-10-12 Memory auto-notes room turns (tag `room`) so decisions follow the agent into DMs and other rooms.
- 2026-10-12 Agent spec rules are applied live by `rules.evaluate` (never copied into the store); validated at spawn.
- 2026-10-12 CLI loads `./.env` from the working directory if present (keys only reach process.env).
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
| 2 | specs, rules/approvals/agents wiring, security fixes, reviews, e2e | 16 calls, ~183k tokens; live DeepSeek ≈ 400 tokens total |
| 3 | specs, workspace tools, memory room notes, reviews, live e2e | 7 calls, ~127k tokens; live DeepSeek ≈ 12k tokens total |
| 4 | security layer, client, reviews, browser e2e | 6 calls, ~92k tokens; live DeepSeek ≈ 8k tokens |
