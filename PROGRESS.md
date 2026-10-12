# Progress

## Current phase: 2 — Headless usable ✅ accepted 2026-10-12 (except driver-acp, parked). Next: Phase 3 — Rooms.

Phase 1 ✅ accepted 2026-10-12 (see git history for its task table).

### Phase 2 tasks

| ID | Task | Who | Status |
|---|---|---|---|
| 2.1 | `drivers/openai-compat.ts` (DeepSeek/OpenAI/OpenRouter/Ollama, SSE) | DeepSeek tests + impl; parser rewrite + hardening by orchestrator | accepted |
| 2.2 | `scripts/live-check.ts` | orchestrator | accepted; live DeepSeek OK |
| 2.3 | `services/rules.ts`, `services/approvals.ts` | orchestrator; independent adversarial tests by DeepSeek | accepted (1 hole found by worker tests, fixed: cross-agent rule scope) |
| 2.4 | `services/memory.ts` | DeepSeek tests + impl | accepted |
| 2.5 | `services/skills.ts` | DeepSeek tests + impl | accepted after **security fix**: install re-downloaded the source and wrote unverified bytes |
| 2.6 | `services/routines.ts` | DeepSeek tests (2nd attempt) + impl | accepted (store API hallucinated, runNow overlap gap — fixed) |
| 2.7 | `cli/run.ts`, `cli/main.ts` | DeepSeek tests + impl | accepted (parameter property, arg strictness, routines run) |
| 2.8 | app wiring, strict startup, monotonic ids | orchestrator | accepted |
| 2.9 | `drivers/acp.ts` (Claude Code) | — | **parked: needs dependency approval** |

### Phase 2 evidence
- `pnpm typecheck` clean · `pnpm test` 393/393 (~1 s; per-test 20 s timeout so hangs fail loudly) · `pnpm spike` 28/28.
- Real processes, live DeepSeek, throwaway data dir: `skills install --yes` → `agents add ada --preset deepseek --memory
  --skill terse --rule …` → `ask` ("Lisbon.", 45 in / 3 out) → piped `chat` (remembered "teal" across turns) →
  quiet `routines run` (silent) → `approvals` (none). API key absent from the SQLite file.
- Mutation checks: skills hash-bound install, rules outside-workdir guard, approvals crash expiry, driver idle reset.

### Review findings worth remembering
- Worker failures were mostly missing context in my briefs (store/driver contracts not pasted → invented APIs).
  Every brief now ships `.delegate/specs/cordis-rules.md` and the contracts it touches.
- Real bugs found by worker-written tests in orchestrator code: same-ms ordering (fixed at the root in `newId`),
  root services not awaited in `createApp` (fixed: every root fiber is awaited and must be ACTIVE).

### Known gaps (Phase 2)
- driver-openai-compat is chat-only: agents on it cannot call tools (so the `remember` tool is unused there; notes
  can still be added and are recalled into the prompt). Tool calling for OpenAI-compatible APIs is a candidate for Phase 3.
- Approvals can only be answered inside the process that asked (CLI prompt). Cross-process answering arrives with the
  server in Phase 4.

## Decisions log

- 2026-10-12 Cordis 4.0.0-rc.10, Node type stripping (no build), TS 5.9.3, `moduleResolution: Bundler`,
  `node:sqlite`. See ARCHITECTURE.md §1.
- 2026-10-12 (user) Repo: private `ShaunTheKing/whales`, push after each accepted task.
- 2026-10-12 (user) Rooms: rule `allow` is downgraded to `ask`; `deny` still denies.
- 2026-10-12 (user) Hires: lead proposes, the user approves each via the approvals queue (`agent.hire`).
- 2026-10-12 `AgentRuntime.busy` = queued or running (contract wording updated).
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
