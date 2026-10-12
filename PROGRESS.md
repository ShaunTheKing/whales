# Progress

## Status: Phases 0–6 ✅ accepted 2026-10-12. Parked: driver-acp (Claude Code) awaiting dependency approval.

### Phase 6 tasks (user request: Electron app, plugin marketplace, cleaner UI)

| ID | Task | Who | Status |
|---|---|---|---|
| 6.1 | Room-scoped tools/prompt sections (`core/scope.ts`), room plugin loader, `agents.update` | orchestrator | accepted (mutation-checked) |
| 6.2 | `services/market.ts`: index sources, pinned git fetch, digest-checked preview → install, load-time re-hash | orchestrator | accepted (mutation-checked) |
| 6.3 | Example plugins `dice`, `deepseek-delegate`, `web-fetch` | orchestrator | accepted |
| 6.4 | API `/catalog`, `/market/*`, `/agents/:id/plugins`, `/rooms/:id/plugins` | orchestrator | accepted |
| 6.5 | Stylesheet redesign, MarketView, PluginPicker | DeepSeek (3 parallel); orchestrator review + integration | accepted |
| 6.6 | Electron shell `desktop/main.ts`, macOS hidden title bar, unsigned arm64 dmg | orchestrator | accepted |

### Phase 6 evidence
- `pnpm test` 603/603 · typecheck clean (server + web).
- Mutation checks: room scope off → 2 room-plugin tests fail; install re-hash off → tamper test fails; load-time re-hash off
  → on-disk tamper test fails.
- Marketplace tests use a real local git repo + index server: wrong commit, non-GitHub repo, `..` paths, redirects,
  symlinks, built-in name squatting, broken modules, upgrade, uninstall-while-used, restart reload.
- Browser run (in-app browser): plugin drawer turns `dice` on for an agent; folder install through the preview dialog
  (Install disabled until acknowledged); Installed tab shows usage.
- Electron: `pnpm desktop` and the packaged `Whales.app` both start, render signed in, token stripped from the URL
  (smoke mode `WHALES_DESKTOP_SMOKE=1`). app.asar holds only dist/, web/dist/, plugins/ and the runtime deps
  (hono, @hono/node-server, ws, cordis, cosmokit).

### Phase 5 tasks

| ID | Task | Who | Status |
|---|---|---|---|
| 5.1 | `services/checkpoints.ts` shadow-git undo + per-agent plugin | orchestrator; 20 adversarial tests by DeepSeek + 1 by orchestrator | accepted |
| 5.2 | `core/backup.ts` + `store.backupTo` | DeepSeek tests + impl (backupTo by orchestrator) | accepted |
| 5.3 | `bridges/telegram.ts` | DeepSeek tests + impl; orchestrator review | accepted after **deadlock fix** |
| 5.4 | Checkpoint API routes + History panel | DeepSeek | accepted (added `checkpoints.get`) |
| 5.5 | CLI `checkpoints`, `backup`, `restore` | orchestrator | accepted |
| 5.6 | Packaging: compiled `dist/`, `bin`, `files`, `prepack`; Node 22 support | orchestrator | accepted |

### Phase 5 evidence
- `pnpm test` 584/584 on Node 26 **and on Node 22.18** · typecheck clean · UI builds · spike 28/28.
- Checkpoint attacks (malicious hooks/fsmonitor/filters in the agent's own .git, GIT_* env injection, symlinks, traversal)
  all fail; removing the env scrub makes an env-defined `.gitattributes` filter actually execute (test catches it).
- Telegram: a turn waiting for approval could never be approved from Telegram (poller blocked) — fixed; the regression
  test hangs with the old code.
- Real processes: checkpoint diff/restore (with approval) and backup → wipe → restore via the CLI.
- `pnpm pack` → global install into a temp prefix → installed `whales` creates agents, answers, serves the UI; 7 runtime
  packages; tarball contains no TypeScript sources, tests, `.env` or staging files.

### Known gaps (Phase 6)
- DeepSeek Harness (dsh) plugins are not compatible: they target DSH's own host services. Whales has its own index format.
- No default marketplace source: the repo is private, so its raw URLs need auth. A public index repo is needed to browse.
- web-fetch checks DNS before fetching (rebinding window between lookup and connect); it is an example plugin.
- The dmg is unsigned and has the default Electron icon; first open needs right-click → Open.
- No CLI for the marketplace yet (UI and HTTP API only).

### Known gaps (end of plan)
- driver-acp (Claude Code) not built: needs `@agentclientprotocol/sdk` (+ adapter) approval.
- Telegram verified only against a mock Bot API (no live bot token).
- No CI workflow yet (Actions minutes on a private repo — awaiting user OK).
- Tool calls inside room turns are not persisted after the round; DeepSeek-reasoner + tools not supported.
- Single-user by design: one API token grants full control.

## Decisions log

- 2026-10-12 Cordis 4.0.0-rc.10, Node type stripping (no build), TS 5.9.3, `moduleResolution: Bundler`,
  `node:sqlite`. See ARCHITECTURE.md §1.
- 2026-10-12 (user) Repo: private `ShaunTheKing/whales`, push after each accepted task.
- 2026-10-12 (user) Rooms: rule `allow` is downgraded to `ask`; `deny` still denies.
- 2026-10-12 (user) Hires: lead proposes, the user approves each via the approvals queue (`agent.hire`).
- 2026-10-12 `AgentRuntime.busy` = queued or running (contract wording updated).
- 2026-10-12 Packaging compiles to dist/ (Node will not type-strip inside node_modules); package stays `private`.
- 2026-10-12 Checkpoints require a known agent (workspace resolved from its spec) and live outside the workspace.
- 2026-10-12 Server: `ws` instead of `@hono/node-ws` (peer-dep conflict); token always required, even on loopback.
- 2026-10-12 Agent specs may not contain secret values (same rule as whales.config.json).
- 2026-10-12 Hires get unique ids AND display names; hire approval uses strict mode (allow rules cannot skip the human).
- 2026-10-12 Memory auto-notes room turns (tag `room`) so decisions follow the agent into DMs and other rooms.
- 2026-10-12 Agent spec rules are applied live by `rules.evaluate` (never copied into the store); validated at spawn.
- 2026-10-12 CLI loads `./.env` from the working directory if present (keys only reach process.env).
- 2026-10-12 `defaults.cheapDriver` in whales.config.json replaces the default as a whole (no deep merge).
- 2026-10-12 (user) Electron desktop app, unsigned dmg; marketplace plugins run in-process after an approved install;
  marketplace lists come from GitHub-hosted index files; UI restyled in the spirit of CopilotKit/OpenDots (no code copied).

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
| 5 | checkpoints, CLI, packaging, Node 22 check, reviews | 7 calls, ~105k tokens; no live model calls |
| 6 | market + room scope + desktop + API (~1,300 lines), integration, browser + Electron checks | 3 calls, ~25k tokens; no live model calls |
