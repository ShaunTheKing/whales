# Whales

A local-first multi-agent workspace on [Cordis](https://github.com/cordiverse/cordis) 4. Every agent is its own
isolated Cordis context with its own plugins (driver, memory, skills, tools); disposing it tears everything down.
Design: [ARCHITECTURE.md](ARCHITECTURE.md) · status: [PROGRESS.md](PROGRESS.md).

Requires Node ≥ 22.18 (tested on 22.18 and 26) and pnpm. In the repo, Node runs the TypeScript directly.

```bash
pnpm install
pnpm check            # typecheck + tests
```

### Install as a command

```bash
pnpm pack                                   # builds dist/ + the web UI, writes whales-0.0.0.tgz
npm install -g ./whales-0.0.0.tgz           # then: whales help
```

## Desktop app (macOS)

```bash
pnpm desktop          # build, then open the Whales window
pnpm desktop:dist     # build an unsigned arm64 .dmg into release/
```
The window runs the same server as `whales serve` internally (127.0.0.1, random port, new token every launch).
For model keys, put them in `~/.whales/.env` (e.g. `DEEPSEEK_API_KEY=…`); apps started from Finder don't see your shell's
environment. The dmg is unsigned: the first time, right-click Whales.app → Open.

## Models

Open **Models** in the sidebar and choose **Add provider**. The options are DeepSeek, OpenAI, OpenCode Zen, OpenRouter,
Ollama (local), or any OpenAI-compatible URL.

- **Keys.** Paste the API key. It is saved to your Mac's **Keychain** (item "Whales: <name>", service `whales.provider`)
  and never to Whales' database or files. You can see or delete it in Keychain Access.
- **Test.** Lists the provider's models with that key. Use it to fill the model list.
- **New agents.** The New agent form then offers the provider and its models.
- **Changing a key.** Agents pick up the new key on their next message.
- **Env vars still work.** Variables like `DEEPSEEK_API_KEY` remain a fallback, e.g. on Linux or for the CLI.

## Plugin marketplace

Open **Marketplace** in the sidebar:

- **Sources.** Add an index file: a JSON list of plugins, each pinned to a GitHub repo and an exact commit.
- **Discover.** Browse the sources. You can also install straight from a GitHub repo and commit, or from a local folder.
- **Install.** First you see a preview: the files, their size, a content hash and any warnings. Plugins are third-party code
  that runs with full access, so Install is enabled only after you tick the acknowledgement.

Then use the **Plugins** button in any chat or room to switch plugins on:

- **In a chat:** the plugin becomes part of that agent.
- **In a room:** every member gets it, but its tools exist only inside that room.

Example plugins live in [`plugins/`](plugins):

- `dice`
- `deepseek-delegate`: hand a subtask to a DeepSeek worker; needs `DEEPSEEK_API_KEY`.
- `web-fetch`

Install them with *Install from GitHub or a folder → folder*.

**Writing a plugin.** A plugin is a folder with a `whales-plugin.json` (`name`, `version`, `description`, `entry`,
optional `scopes`) and an entry module. The entry `export default`s a Cordis plugin object such as
`{ name, inject: ['tools'], apply(ctx, config) { ctx.tools.register(…) } }`. It may not have dependencies; Node built-ins
are fine. See `plugins/dice/index.js`.

## Web UI

```bash
pnpm --filter whales-web build
node src/cli/main.ts serve            # prints a one-time link: http://127.0.0.1:7777/#token=…
```
Open the printed link. The UI streams agent and room replies, shows tool calls, and asks you to approve actions
(file writes, hires, …) with cards. The API requires the token on every request, even on localhost.

## CLI

API keys are read from environment variables by name (put them in `.env`, which is git-ignored and loaded
automatically). Data lives in `~/.whales` unless `WHALES_DATA_DIR` is set.

```bash
alias whales="node $PWD/src/cli/main.ts"
whales agents add ada --name Ada --role "a helpful assistant" --preset deepseek --model deepseek-chat --memory
whales ask ada "What is the capital of Portugal?"
whales chat ada
whales rules add "deny running commands matching rm *" --agent ada
whales skills install /path/to/skill-dir        # shows a preview and asks before installing
whales routines add ada --every 60 --prompt "Anything I should know?" --quiet --window 09:00-18:00
whales agents add cora --name Cora --seniority 10 --preset deepseek --model deepseek-chat --memory --workspace
whales rooms create Style --members cora,ana,ben
whales rooms post <roomId> "Tabs or spaces?"     # members speak in seniority order; the most senior decides
whales team propose cora "Set up CI"             # the lead drafts a team…
whales team hire <proposalId>                    # …and nobody is hired until you approve
whales daemon                                    # runs routines; answer approvals inline
whales checkpoints list cora                     # workspace undo: snapshots before/after each turn (--workspace + checkpoints plugin)
whales checkpoints restore <checkpointId>        # asks first, keeps a safety snapshot
whales backup --out ~/whales-backups             # consistent copy of the database, skills, workspaces, checkpoints
whales restore ~/whales-backups/whales-backup-…  # stop serve/daemon first; never deletes (moves old data aside)
whales help
```

## Telegram

Give an agent the `bridge-telegram` plugin with your bot token in `TELEGRAM_BOT_TOKEN` and the chat ids allowed to talk to it:
`{ "name": "bridge-telegram", "config": { "allowedChatIds": [123456789] } }`. Messages from other chats are ignored;
approvals for that agent arrive as messages with Allow / Always / Deny buttons.
