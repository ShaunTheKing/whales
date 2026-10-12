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
| D13 | **Distribution = compiled JS** (`tsc -p tsconfig.build.json`, `rewriteRelativeImportExtensions`) | Node refuses to type-strip files under node_modules; the repo itself still runs .ts directly. |
| D14 | **Desktop = Electron `44.4.5`** (dev dep) + **electron-builder `26.16.1`** (dev dep), unsigned arm64 `.dmg` (user request, Phase 6) | Electron 44 ships Node 24 with `node:sqlite`, so the main process runs the unchanged app + server; the window loads the existing web UI. Neither is a runtime dependency of the CLI package. |
| D15 | **Plugin marketplace: in-process plugins, approved at install** (user choice over an isolated process) | Simplest model that lets plugins register tools/prompt sections like built-ins. Safety comes from pinning (GitHub repo + full commit), digest-checked staging, no install scripts/dependencies, and user-only install routes — not from isolation. |
| D17 | **Model providers with keys in the macOS Keychain** (user request) via `/usr/bin/security` (no new dependency) | Keys entered in the UI must persist somewhere safer than files; the Keychain is the OS secret store. Writes use `security -i` with the command on stdin so the key never appears in argv. Env-var names still work (headless, non-macOS). |
| D18 | **Web search = built-in `web-search` plugin + one app-wide backend** (Brave, Tavily or self-hosted SearXNG); keys in the Keychain. Pages fetched by `core/web.ts` with address checks inside the socket's DNS lookup | No new dependency. Vetting the address in the lookup the socket uses removes the DNS-rebinding gap of "resolve, check, then fetch". |
| D19 | **Markdown rendered by our own parser into React elements** (no HTML strings, no new dependency) | Model output must never become markup; a ~300-line parser covers what chat replies use (headings, lists, tables, code, links). |
| D16 | **Room plugins = room-scoped branches of each member's context** (`ctx.extend({[ROOM_SCOPE]: roomId})`) | Their tools and prompt sections are filtered per turn by room id, so the same agent keeps a clean DM toolset; agent-wide tools win on a name clash. |

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
`read_file`, `write_file` confined to the workdir). `checkpoints` (snapshots before/after each turn), `bridge-telegram`. Planned: `driver-acp`. A plugin's `config` is validated by
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

## 10b. Marketplace and desktop security (Phase 6)

**Marketplace** (`services/market.ts`, orchestrator-owned). Index files are fetched over https only, with no redirects, a
1 MiB cap and a strict schema. Each entry pins `https://github.com/<owner>/<repo>` to a full 40-hex commit. Installs run git
through `core/git.ts` with the scrubbed environment shared with checkpoints. That run also has: https as the only protocol,
no redirects, `core.symlinks=false`, fsck, no submodules, and a fetch of exactly that commit, verified with `rev-parse`.

The staged folder is limited to 2,000 files and 20 MiB. It may not contain symlinks or special files, and it must have a
`whales-plugin.json` whose entry stays inside the plugin. Its sha256 digest covers both paths and contents. Install requires
the preview's digest and `acknowledge: true`, re-hashes the staged files, and moves exactly those files into
`<dataDir>/plugins/<name>/<digest16>/`. At every start the folder is re-hashed, and a plugin modified on disk is refused.

What Whales never does for a plugin: run install scripts, fetch dependencies, or offer an agent tool that reaches these
routes. Built-in names cannot be taken. Uninstall is refused while an agent or room still lists the plugin. ESM modules
cannot be unloaded, so removed code stays in memory until restart.

Plugins run in-process with full access, which is what the user accepted at install. Their tools still go through rules and
approvals like any other tool.

**Desktop** (`desktop/main.ts`, orchestrator-owned). The app and server run in the Electron main process, bound to
127.0.0.1 on a random port. The token is random per launch and never comes from the environment. The renderer runs with
`contextIsolation`, `sandbox` on and no preload, so it is an ordinary web page with the same CSP as `whales serve`.
Navigation is pinned to the server origin, and http(s) links open in the system browser. New windows, webviews and every
permission request are denied. A single-instance lock protects the database. Keys are read from `<dataDir>/.env`.

## 10c. Model provider keys (Phase 7)

`core/keychain.ts` and `services/providers.ts` are orchestrator-owned.

- **Storage.** Provider records (store collection `providers`) hold a name, base URL, models and an optional env-var
  *name*, never a key. Keys are Keychain generic passwords: service `whales.provider`, account = provider id.
- **Write path.** `security -i` reads `add-generic-password … -w "<key>"` from stdin, and the write is verified by reading
  it back. Keys must match `^[A-Za-z0-9._~+/=:-]{8,1024}$`, so the interactive line cannot be broken out of.
- **Read path.** `security find-generic-password -w`, used only by `resolveKey`, which serves the driver and the
  connection test.
- **Leak protection.**
  - Keys travel only to the provider's https base URL; plain http is allowed for loopback only.
  - Every error from a test or a driver turn is redacted with the key in hand.
  - No API response contains a key; tests assert this on every route.
- **Agents.** An agent references a provider by id (`driver.config.provider`), so a key change applies on the next turn
  without a restart. Deleting a provider that agents still use is refused; a successful delete also deletes its Keychain
  item.

## 10d. Web search and page reading (Phase 8)

`services/search.ts`, `services/web-search.ts` and `core/web.ts` are orchestrator-owned.

- **web_search.** The agent controls only the query; endpoints are fixed (Brave, Tavily) or user-set (SearXNG).
  - Permission kind `tool`, target `web_search`: the first search asks, and "Allow always" lets that agent search.
  - Keys are resolved per call and redacted from errors.
- **web_open.** Permission kind `network`, with the URL as target.
  - **What it refuses:** non-http(s) URLs, URLs with credentials, and `localhost`, `.local`, `.internal` and `.home.arpa`
    names. Every address a name resolves to is checked inside the socket's own DNS lookup and refused when private,
    loopback, link-local, CGNAT, multicast, or mapped or translated IPv6.
  - **Redirects and limits:** redirects are re-checked on every hop (max 5). Pages are capped at 2 MB, 20 s and 20k
    characters returned. Only text types are decoded.
- **Markdown.** `web/src/lib/markdown*.ts(x)` builds React elements. Links render only for http(s) and mailto, open in a
  new window, and the desktop shell sends them to the system browser. A line that is entirely bold becomes a heading.

## 11. Phase map

0. Design (this doc + contracts). 1. Spike: core, agents, driver-stub, isolation and dispose proof.
2. Headless: store, openai-compat and ACP drivers, tools, memory, skills, rules, approvals, routines, CLI.
3. Rooms, team proposals and hires. 4. Server + web UI. 5. Checkpoints, backups, Telegram, packaging.
6. (user request) Electron desktop app, plugin marketplace with per-chat/per-room plugins, UI redesign.
8. (user request) Live web search (web_search + web_open) and Markdown rendering of replies.
7. (user request) Models page: DeepSeek / OpenAI / OpenCode Zen / OpenRouter / Ollama / custom providers, keys in the Keychain.
