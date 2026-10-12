# Progress

## Current phase: 3 — Rooms ✅ accepted 2026-10-12. Next: Phase 4 — Server + web UI (awaiting go-ahead).

Phases 1 and 2 ✅ accepted 2026-10-12 (task tables in git history). driver-acp still parked (needs dependency approval).

### Phase 3 tasks

| ID | Task | Who | Status |
|---|---|---|---|
| 3.1 | Tool calling in driver-openai-compat (streamed fragments, multi-round loop) | DeepSeek tests + impl; orchestrator review | accepted (round-limit fix: refuse before executing) |
| 3.2 | `services/workspace.ts` list/read/write files, confined + gated | orchestrator; adversarial tests by DeepSeek | accepted (symlink escape mutation-checked) |
| 3.3 | `services/rooms.ts` rounds, seniority order, arbiter, notes, team propose/hire | DeepSeek tests + impl; orchestrator review | accepted (prompt was missing the user message; fixed) |
| 3.4 | Room turns → memory notes (memory follows the agent across rooms) | orchestrator | accepted (gap found in the live run) |
| 3.5 | CLI `rooms …`, `team …`, `agents add --workspace` | DeepSeek tests + impl | accepted |

### Phase 3 evidence
- `pnpm typecheck` clean · `pnpm test` 480/480 · `pnpm spike` 28/28.
- Acceptance test (3 agents, no overlapping turns, senior last with arbiter instruction, sees the others' replies)
  passes and fails when seniority order is reversed.
- Live DeepSeek, real processes: Ana (tabs) vs Ben (spaces) → Cora (seniority 10) speaks last and rules "spaces, four
  per level" addressing both; in a later DM Cora recalls the room decision from memory, calls `write_file`, the CLI
  asks for approval (path + size), and STYLE.md is written inside her workspace only; `team propose` → approval →
  2 hires on the cheap driver (seniority 9, hiredBy cora, ask mode), a hire answers who hired it and why.

### Known gaps (Phase 3)
- DeepSeek-reasoner + tools: reasoning_content is not sent back between tool rounds; use deepseek-chat for tool use.
- Approvals still answerable only in the asking CLI process (server in Phase 4).

## Decisions log

- 2026-10-12 Cordis 4.0.0-rc.10, Node type stripping (no build), TS 5.9.3, `moduleResolution: Bundler`,
  `node:sqlite`. See ARCHITECTURE.md §1.
- 2026-10-12 (user) Repo: private `ShaunTheKing/whales`, push after each accepted task.
- 2026-10-12 (user) Rooms: rule `allow` is downgraded to `ask`; `deny` still denies.
- 2026-10-12 (user) Hires: lead proposes, the user approves each via the approvals queue (`agent.hire`).
- 2026-10-12 `AgentRuntime.busy` = queued or running (contract wording updated).
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
