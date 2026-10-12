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
