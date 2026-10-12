# Whales

A local-first multi-agent workspace on [Cordis](https://github.com/cordiverse/cordis) 4. Every agent is its own
isolated Cordis context with its own plugins (driver, memory, skills, tools); disposing it tears everything down.
Design: [ARCHITECTURE.md](ARCHITECTURE.md) · status: [PROGRESS.md](PROGRESS.md).

Requires Node ≥ 22.18 and pnpm. No build step: Node runs the TypeScript directly.

```bash
pnpm install
pnpm check            # typecheck + tests
```

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
whales daemon                                    # runs routines; answer approvals inline
whales help
```
