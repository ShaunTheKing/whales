# Whales — Architecture

A local-first multi-agent workspace built on [Cordis](https://github.com/cordiverse/cordis) 4.
Clean-room: concepts inspired by bloks, no code, assets or branding copied.

**Core idea.** Every agent is its own forked, isolated Cordis `Context` with its own plugin set
(driver, memory, tools, skills, bridges). Disposing that context stops the agent and tears down
everything it registered: listeners, timers, sockets, child processes, prompt sections and tools.

The TypeScript contracts in [`src/contracts/`](src/contracts) are the source of truth. This document
explains them; if the two disagree, the contracts win and this file gets fixed.

---

## 1. Decisions

| # | Decision | Why |
|---|----------|-----|
| D1 | **Cordis `4.0.0-rc.10`**, pinned exactly | Latest line; v4 has `ctx.isolate`, fibers and `ctx.effect`, which is exactly the agent model. RC risk: we pin and wrap Cordis only in `core/` and `services/agents`. |
| D2 | **No build step.** Node runs `.ts` directly (type stripping), Node ≥ 22.18 | Removes tsx/tsc emit from the loop. Forces `erasableSyntaxOnly`: no `enum`, no parameter properties, no runtime `namespace`. |
| D3 | **TypeScript `5.9.3`** for `tsc --noEmit` only | Stable, `erasableSyntaxOnly` supported. TS 7 (native) postponed until it has bedded in. |
| D4 | **`moduleResolution: Bundler`**, explicit `.ts` extensions in our imports | Cordis's published `.d.ts` use extensionless relative imports, which `NodeNext` cannot resolve (verified: every Cordis export became unresolved). Our own code always writes `./x.ts`, so Node's runtime resolution still works. |
| D5 | **Store = built-in `node:sqlite`**, one JSON-document table | Zero native deps (no `better-sqlite3` compile). Local scale, so JSON documents + indexed `(collection, scope, created_at)` is enough; schema changes become data migrations. |
| D6 | **Server = Hono 4.13.9** + `@hono/node-server` 2.1.1 + **`ws` 8.22.0** for WebSockets | Small and typed. `@hono/node-ws` only supports node-server 1.x, so upgrades are handled with `ws` directly, which also keeps the auth handshake in our hands. Versions pinned ≥ 2 weeks old. |
| D7 | **Web = React 19.3 + Vite 8.3** in `web/` (pnpm workspace package `whales-web`), no UI libraries | Only the web package pays for the frontend toolchain; ~75 KB gzipped. |
| D8 | **Secrets only by env-var *name*** (`apiKeyEnv: "DEEPSEEK_API_KEY"`) | Specs, DB, config, logs and prompts never contain a key. |
| D9 | **Agentic drivers via ACP** (Agent Client Protocol) | Claude Code and others expose ACP adapters. As the ACP *client*, Whales implements the file and terminal methods itself, so every file write and command passes our rules and approvals and is confined to the agent's workdir. |
| D10 | **Checkpoints = shadow git repo per agent** (Phase 5) | Diff and undo for free; never touches the agent's own `.git`. Requires the `git` binary. |
| D11 | **Memory recall = lexical BM25**, no embeddings | Local, deterministic, no extra model or dependency. The interface allows swapping in embeddings later. |
| D12 | **Tests: `node --test`** with `node:assert/strict` | Built in. |

New dependencies need a row in this table first.

## 2. Directory layout

```
src/
  contracts/        # interfaces only (orchestrator-owned; workers never edit)
  core/
    app.ts          # createApp(config): Context with store, agents, rules, approvals, ... installed
    config.ts       # loadConfig(): WhalesConfig (defaults ← whales.config.json ← env)
    ids.ts          # newId(prefix), validators
  services/
    store.ts        # node:sqlite StoreService
    agents.ts       # AgentsService + AgentRuntime (the per-agent `agent` service)
    tools.ts        # per-agent ToolsService plugin ("tools")
    rules.ts        # parser + evaluator
    approvals.ts
    memory.ts       # per-agent plugin ("memory")
    skills.ts       # root library + per-agent plugin ("skills")
    rooms.ts
    routines.ts
    checkpoints.ts
  drivers/
    stub.ts         # deterministic scripted driver for tests ("driver-stub")
    openai-compat.ts# chat-completions streaming: DeepSeek / Ollama / OpenRouter / OpenAI
    acp.ts          # ACP client over a child process ("driver-acp")
  bridges/
    telegram.ts
  server/           # Phase 4
  cli/main.ts       # `whales chat|agents|rooms|approve`
test/               # mirrors src/, *.test.ts
web/                # Phase 4, own package.json
```

## 3. Context tree

```
root Context  (createApp)
├─ config            value
├─ store             StoreService
├─ agents            AgentsService (+ catalog)
├─ rules, approvals, skills, rooms, routines, checkpoints   ← shared, root-level
│
├─ agent "alice"  = root.isolate('agent').isolate('driver').isolate('memory').isolate('tools')
│   ├─ agent     AgentRuntime(spec)        ← installed first by agents.spawn
│   ├─ tools     ToolsService              ← always installed second
│   ├─ driver    from spec.driver          ← e.g. driver-openai-compat
│   └─ spec.plugins in order               ← memory, skills, bridge-telegram, ...
│
└─ agent "bob"  (own isolated slots; cannot see alice's driver/memory/tools)
```

`PER_AGENT_SERVICES = ['agent', 'driver', 'memory', 'tools']`. Each agent context isolates all four, so a
plugin providing `memory` inside alice is invisible to bob and to root. Root services (store, rules,
approvals, ...) are not isolated, so agents see them.

Spawning is itself a plugin: `agents.spawn` calls `root.plugin(AgentPlugin, spec)` and keeps the returned
`Fiber`. `agents.dispose(id)` calls `fiber.dispose()`, and Cordis disposes every descendant fiber and
effect. That is the entire stop/cleanup mechanism, so **every long-lived resource must be registered
through the context**:

- event listeners: `ctx.on(...)` (never `emitter.on` on a shared object without removal)
- timers, sockets, child processes, watchers: `ctx.effect(() => { ...; return () => cleanup() })`
- services: `class X extends Service` + `super(ctx, 'name')`
- tools and prompt sections: `ctx.tools.register` / `ctx.agent.addPromptSection` inside `ctx.effect`

The probe in Phase 0 confirmed this on the installed Cordis: after `fiber.dispose()` the agent's interval
cleared, its listener stopped receiving root events, its `inject(['tools'])` child disposed, and the
sibling agent kept running.

## 4. Services (summary; full signatures in `src/contracts/`)

| Service | Where | Contract | Notes |
|---|---|---|---|
| `config` | root | `config.ts` | Plain value via `ctx.provide('config', cfg)`. |
| `store` | root | `store.ts` | `collection(name)` → typed `Collection<T>`. Collections are declared by each contract via declaration merging. |
| `agents` | root | `agents.ts` | `spawn / get / list / dispose / restore`, `catalog` of named plugins. |
| `agent` | per agent | `agents.ts` | `AgentRuntime`: identity, prompt sections, serialised `turn()`. |
| `driver` | per agent | `driver.ts` | One `Driver` interface; `run()` returns `AsyncIterable<DriverEvent>` that always ends with `done`. |
| `tools` | per agent | `tools.ts` | Registry; `forTurn()` returns a `ToolSet` whose `invoke` authorizes via approvals. |
| `memory` | per agent | `memory.ts` | Notes scoped `agent:<id>`, so they follow the agent into rooms. Adds a prompt section and a `remember` tool. |
| `skills` | root + per-agent plugin | `skills.ts` | Library: list, read, preview, install(hash). The per-agent `skills` plugin (config `{ names }`) folds skill bodies into the prompt. |
| `rules` | root | `rules.ts` | Sentence rules; pure `evaluate()`. |
| `approvals` | root | `approvals.ts` | `authorize(action)`: the only gate. Blocks until the user answers. |
| `rooms` | root | `rooms.ts` | Turn-taking (one member at a time, ascending seniority), senior-last arbitration, shared notes, team proposals; hires need approval (strict mode) and use `defaults.cheapDriver`. |
| `routines` | root | `routines.ts` | Interval check-ins inside allowed windows; quiet mode. |
| `checkpoints` | root | `checkpoints.ts` | Shadow-git snapshots before and after turns; diff, restore. |

### 4.1 A turn

```
agent.turn(prompt, opts)
  ├─ wait for this agent's turn lock (FIFO)
  ├─ ctx.serial('whales/turn-before', info)         ← checkpoints snapshot here
  ├─ system = persona + sections sorted by order    (skills 100, memory 200, room 300)
  ├─ history = opts.history ?? last N DM messages
  ├─ for await (e of ctx.driver.run({ ..., tools: ctx.tools.forTurn(...) }, signal))
  │     ctx.emit('whales/agent-event', { ...info, event: e }); yield e
  ├─ persist DM user/assistant messages (not for rooms; rooms persist their own)
  └─ ctx.serial('whales/turn-after', { ...info, ok, output })
```

### 4.2 Permission flow

```
tool / ACP request ──► Action{kind,target,agentId,roomId,summary}
                         │
                 approvals.authorize(action, {mode})
                         │
                 rules.evaluate(action, mode) ──► deny ──► refuse (reason returned to model)
                         │                    └─► allow ─► run
                         ▼ ask
           persist ApprovalRequest, emit whales/approval-requested
           driver emits waiting_approval; agent blocks
                         │
           user: answer(id, allow-once | allow-always | deny)   (CLI / HTTP / Telegram)
                         │
           allow-always ⇒ rules.add("allow <subject> matching <target>", agent scope)
```

## 5. Rules

Grammar (case-insensitive, whitespace-normalised, optional trailing `.`):

```
rule        := effect subject [preposition pattern]
effect      := "allow" | "deny" | "ask" ["before"]
subject     := "reading files"                       → file.read
             | ("writing" | "editing") "files"       → file.write
             | ("running commands" | "shell commands") → shell
             | ("network access" | "fetching urls")  → network
             | "using tool" NAME                     → tool, pattern = NAME
             | "using tools"                         → tool
             | "sending messages"                    → message
             | "installing skills"                   → skill.install
             | "hiring agents"                       → agent.hire
preposition := "in" | "under" | "matching" | "to" | "on"
pattern     := glob; "*" any chars except "/", "**" any chars, "?" one char. Absent = "**".
```

Examples: `deny running commands matching rm *` · `allow reading files in src/**` ·
`ask before writing files` · `allow using tool remember` · `deny network access to *.internal`.

Evaluation for an action uses global rules plus `agent:<action.agentId>` rules whose `kind` matches and
whose pattern matches `action.target` (for shell targets, the full command line):

1. any `deny` → **deny**
2. any `ask` → **ask**
3. any `allow` → **allow**, but **ask** if `action.roomId` is set (shared rooms always ask) or mode is `strict`
4. no match → `trusted`: allow · `ask` and `strict`: ask

**Default mode is `ask`.** File targets are normalised to workdir-relative POSIX paths *before* matching;
paths that resolve outside the workdir (after `realpath`) are denied before rules are consulted.

## 6. Events

Cordis's event bus, typed in `src/contracts/events.ts`. Everything a UI needs to render live state is an
event: `whales/agent-spawned|agent-disposed|turn-before|turn-after|agent-event|approval-requested|approval-resolved|room-event|routine-ran`.
The server (Phase 4) subscribes with `ctx.on` and fans out over WebSocket.

## 7. Database schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);                                   -- ('schema_version', '1')

CREATE TABLE IF NOT EXISTS records (
  collection TEXT    NOT NULL,       -- 'agents' | 'messages' | 'rules' | ...
  id         TEXT    NOT NULL,
  scope      TEXT    NOT NULL,       -- 'global' | 'agent:<id>' | 'room:<id>'
  created_at INTEGER NOT NULL,       -- ms epoch
  updated_at INTEGER NOT NULL,
  data       TEXT    NOT NULL,       -- full record as JSON
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_scope ON records (collection, scope, created_at, id);
```

Collections: `agents`, `messages`, `rules`, `approvals`, `memories`, `skillInstalls`, `rooms`,
`roomMessages`, `roomNotes`, `teamProposals`, `routines`, `checkpoints`.
DB file: `<dataDir>/whales.db`. All statements are prepared with bound parameters, never string-built.

## 8. Plugin spec format

Agents are declared as JSON-serialisable `AgentSpec`s (persisted in `agents`):

```json
{
  "id": "alice",
  "name": "Alice",
  "role": "Tech lead",
  "seniority": 10,
  "driver": { "name": "driver-openai-compat", "config": { "preset": "deepseek", "model": "deepseek-chat" } },
  "plugins": [
    { "name": "memory" },
    { "name": "skills", "config": { "names": ["code-review"] } }
  ],
  "rules": ["allow reading files", "deny running commands matching rm *"],
  "permissionMode": "ask"
}
```

`name` is resolved through `agents.catalog`. Built-in names: `driver-stub`, `driver-openai-compat` (chat + tool
calling), `memory` (notes + `remember` tool; auto-notes room turns), `skills`, `workspace` (`list_files`,
`read_file`, `write_file` confined to the workdir). Planned: `driver-acp`, `checkpoints`, `bridge-telegram`. A plugin's `config` is validated by
its own `Config` (Standard Schema) when it declares one; otherwise it validates by hand and throws a
readable error.

`driver-openai-compat` config: `{ preset?: 'deepseek'|'openai'|'openrouter'|'ollama', baseUrl?, model, apiKeyEnv?, temperature?, maxTokens? }`.
`driver-acp` config: `{ command, args?, env? }`. It may only be set by the user; `rooms.hire` always uses
`config.defaults.cheapDriver`.

## 9. Coding conventions (workers must follow)

- Node ≥ 22.18, ESM, TypeScript strict, **erasable syntax only**: no `enum`, no constructor parameter
  properties, no runtime `namespace`, no decorators. Relative imports always end in `.ts`.
- Import contract types from `../contracts/index.ts` (or the specific file) with `import type`.
- A service is `class FooService extends Service implements FooContract` with
  `static inject = [...]` and `constructor(ctx: Context, config) { super(ctx, 'foo'); ... }`.
- Cordis's `FiberState` is an ambient `const enum`, which `isolatedModules` forbids. Compare
  against the numbers via the local constants in `core/` if needed.
- **Declare `inject` for every service a plugin touches as `ctx.foo`** (`static inject = ['store']`, or
  `{ inject: ['tools'], apply }`). Cordis 4 throws `cannot get property "foo" without inject` otherwise.
  `ctx.get('foo')` needs no inject and returns `undefined` when absent.
- Inside a service method, `this.ctx` is the **caller's** context (Cordis tracing). That is what makes
  `register()`-style APIs clean up with the calling plugin; a service that needs its own context must keep
  it in a separate field (see `Runtime.actx`).
- `await ctx.plugin(p)` also resolves when `p` is stuck PENDING on a missing inject. Check
  `fiber.state === 2` (ACTIVE) when readiness matters (see `Agents.spawn`).
- **No JS `#private` fields on Services** — use the TS `private` keyword. `ctx.get(name)` and `ctx.name`
  return a Cordis tracing Proxy, and `#private` access through a Proxy throws `TypeError`. For the same
  reason, never compare `ctx.foo === ctx.get('foo')`.
- Long-lived resources only through `ctx.effect` / `ctx.on` (§3). Nothing global or module-level mutable.
- No `any` (use `unknown` and narrow). No non-null `!` on external data. No swallowed errors: either
  rethrow, return as an `error` event / `isError` result, or `ctx.logger('x').warn(...)` with context.
- Ids: `newId(prefix)` from `core/ids.ts` (`<prefix>_<time-sortable random>`).
- Time comes from `Date.now()` behind an injectable `now()` where tests need it.
- No new dependencies. No `TODO`, placeholder or stub code outside `drivers/stub.ts`.
- Tests: `test/<path>.test.ts`, `node:test` + `node:assert/strict`, in-memory store (`:memory:`),
  no network, no real API keys, temp dirs under `os.tmpdir()` removed in `after()`.
- Never log, persist or emit API keys or tokens.

## 10. Security boundaries (orchestrator-owned code)

Written or line-by-line reviewed by the orchestrator: `services/rules.ts`, `services/approvals.ts`,
`services/tools.ts` (authorize path), `drivers/acp.ts` (fs and terminal handlers, path confinement),
`services/checkpoints.ts`, `services/skills.ts` (install path and name validation), config and secret
loading, server auth.

Isolation between agents is **lifecycle-scoped only**: separate service slots and teardown, not an OS
sandbox. All agents share one process and one user account. Confinement of file and shell access comes
from the permission gate and workdir checks, not from Cordis.

## 10a. Server security (Phase 4)

`whales serve` binds 127.0.0.1 by default. Every `/api` request needs `Authorization: Bearer <token>` (constant-time
compare; token from `$WHALES_API_TOKEN`, else random per start) **and** a Host header naming this server (DNS-rebinding
defence) **and**, when a browser sends one, an Origin equal to this server (or `--dev` Vite origins). Bodies are capped at
1 MiB (413 closes the connection). `/api/events` (WebSocket) checks Host/Origin at upgrade and requires
`{"type":"auth","token":…}` as the first message within 5 s. Static UI files are served from `web/dist` by real path with
CSP, nosniff, no framing and no referrer. The UI receives the token in the URL fragment, keeps it in sessionStorage and strips
it from the address bar. Binding beyond loopback requires a fixed env token.

## 11. Phase map

0. Design (this doc + contracts). 1. Spike: core, agents, driver-stub, isolation and dispose proof.
2. Headless: store, openai-compat and ACP drivers, tools, memory, skills, rules, approvals, routines, CLI.
3. Rooms, team proposals and hires. 4. Server + web UI. 5. Checkpoints, backups, Telegram, packaging.
