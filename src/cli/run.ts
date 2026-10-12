import path from 'node:path'
import fs from 'node:fs/promises'
import readline from 'node:readline'
import { parseArgs } from 'node:util'
import type { Readable } from 'node:stream'

import { createApp, type App } from '../core/app.ts'
import { loadConfig, ConfigError } from '../core/config.ts'
import type { AgentSpec, PermissionMode, PluginRef } from '../contracts/core.ts'
import type { AgentRecord } from '../contracts/agents.ts'
import type { Rule } from '../contracts/rules.ts'
import type { Routine } from '../contracts/routines.ts'
import type { ApprovalRequest } from '../contracts/approvals.ts'
import type { DriverEvent, StopReason } from '../contracts/driver.ts'
import type {} from '../contracts/index.ts'
import { cmdRooms, cmdTeam } from './rooms.ts'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { startServer } from '../server/server.ts'
import { cmdBackup, cmdCheckpoints, cmdRestore } from './maintenance.ts'

export interface CliIO {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  stdin: Readable
  env: Record<string, string | undefined>
  cwd: string
}

export const USAGE = `whales — multi-agent orchestrator

Usage: whales <command> [options]

Commands:
  agents list                          list persisted agents
  agents add <id> --name <n> [...]     create and persist an agent
                                       (--memory, --workspace, --skill <s>, --rule "<r>")
  agents remove <id> [--forget]        delete an agent (and its data)
  agents show <id>                     print the stored agent spec
  ask <id> <prompt...>                 run one turn and stream the reply
  chat <id>                            interactive REPL with an agent
  rules list [--agent id]              list rules
  rules add "<sentence>" [--agent id]  add a rule
  rules remove <id>                    remove a rule
  skills list                          list installed skills
  skills preview <source>              preview a skill without installing
  skills install <source> [--yes]      install a skill
  skills remove <name>                 remove a skill
  routines list [--agent id]           list routines
  routines add <agentId> --every <m> --prompt "<p>" [...]
  routines remove <id>                 remove a routine
  routines run <id>                    run a routine now
  rooms create <name> --members a,b,c  create a shared room
  rooms list | history <id> | delete <id>
  rooms post <id> <message...>         run one round; the most senior member speaks last
  rooms note <id> <text...>            add a shared note
  rooms members <id> add|remove <agent>
  team propose <lead> <goal...>        the lead drafts a team (nothing is hired)
  team hire <proposalId>               hire the team after your approval
  approvals [--all]                    show the approval audit log
  checkpoints list|snapshot|diff|restore <agent|checkpoint>   workspace undo (--label, --to)
  backup [--out <dir>]                 consistent backup of the data dir
  restore <dir> [--force] [--yes]      restore a backup (stop serve/daemon first)
  daemon                               restore agents and run routines
  serve [--port n] [--host h] [--dev]  HTTP/WebSocket API + web UI (prints a one-time UI link)
  help                                 show this help

Run 'whales help' for this message.
`

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const API_KEY_ENV_RE = /^[A-Z][A-Z0-9_]*$/
const DRIVERS = ['openai', 'stub'] as const
const PRESETS = ['deepseek', 'openai', 'openrouter', 'ollama'] as const
const MODES: readonly PermissionMode[] = ['ask', 'strict', 'trusted']

export class UsageError extends Error {
  override name = 'UsageError'
}

export class CliError extends Error {
  override name = 'CliError'
}

export function usage(message: string): never {
  throw new UsageError(message)
}

export function fail(message: string): never {
  throw new CliError(message)
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Lazily-created shared line reader over io.stdin. */
export class LineReader {
  private rl: readline.Interface | undefined
  private iter: AsyncIterator<string> | undefined
  private closed = false
  private readonly input: Readable

  constructor(input: Readable) {
    this.input = input
  }

  private ensure(): AsyncIterator<string> {
    if (!this.rl) {
      this.rl = readline.createInterface({ input: this.input, terminal: false })
      this.iter = this.rl[Symbol.asyncIterator]()
    }
    const iter = this.iter
    if (!iter) throw new Error('line reader not initialised')
    return iter
  }

  async next(): Promise<string | undefined> {
    if (this.closed) return undefined
    const iter = this.ensure()
    const res = await iter.next()
    if (res.done) {
      this.closed = true
      return undefined
    }
    return res.value
  }

  close(): void {
    this.closed = true
    if (this.rl) {
      this.rl.close()
      this.rl = undefined
      this.iter = undefined
    }
  }
}

export interface Ctx {
  io: CliIO
  lines: LineReader
  app: App
}

interface TurnResult {
  stopReason: StopReason
  inputTokens: number | undefined
  outputTokens: number | undefined
}

async function streamTurn(ctx: Ctx, handle: { runtime: { turn(prompt: string): AsyncIterable<DriverEvent> } }, prompt: string): Promise<TurnResult> {
  let stopReason: StopReason = 'error'
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  for await (const event of handle.runtime.turn(prompt)) {
    if (event.type === 'text') {
      ctx.io.stdout.write(event.delta)
    } else if (event.type === 'thinking') {
      ctx.io.stderr.write(event.delta)
    } else if (event.type === 'error') {
      ctx.io.stderr.write(`error: ${event.message}\n`)
    } else if (event.type === 'usage') {
      inputTokens = event.inputTokens
      outputTokens = event.outputTokens
    } else if (event.type === 'done') {
      stopReason = event.stopReason
    }
  }
  ctx.io.stdout.write('\n')
  if (inputTokens !== undefined && outputTokens !== undefined) {
    ctx.io.stderr.write(`[${stopReason} · ${inputTokens} in / ${outputTokens} out]\n`)
  } else {
    ctx.io.stderr.write(`[${stopReason}]\n`)
  }
  return { stopReason, inputTokens, outputTokens }
}

function installApprovalHandler(ctx: Ctx): () => void {
  return ctx.app.ctx.on('whales/approval-requested', (req: ApprovalRequest) => {
    void (async () => {
      const kind = req.action.kind
      const target = req.action.target
      ctx.io.stderr.write(
        `\napproval needed: ${req.action.summary} (${kind} ${target}) — [y]es once, [a]lways, [n]o? `,
      )
      const line = await ctx.lines.next()
      const answer = (line ?? '').trim().toLowerCase()
      let decision: 'allow-once' | 'allow-always' | 'deny' = 'deny'
      if (answer === 'y' || answer === 'yes') decision = 'allow-once'
      else if (answer === 'a' || answer === 'always') decision = 'allow-always'
      ctx.app.ctx.approvals.answer(req.id, decision)
    })()
  })
}

export async function spawnStored(ctx: Ctx, id: string): Promise<{ runtime: { turn(prompt: string): AsyncIterable<DriverEvent> } }> {
  const rec = ctx.app.ctx.store.collection('agents').get(id)
  if (!rec) fail(`unknown agent ${id}`)
  try {
    const handle = await ctx.app.ctx.agents.spawn(rec.spec, { persist: false })
    const runtime = handle.runtime
    if (!runtime) fail(`agent ${id} has no runtime`)
    return { runtime }
  } catch (err) {
    fail(errMessage(err))
  }
}

// ---------------------------------------------------------------------------
// agents
// ---------------------------------------------------------------------------

function parseAgentsAdd(args: string[]): {
  id: string
  name: string
  role: string | undefined
  instructions: string | undefined
  seniority: number
  driver: string
  preset: string | undefined
  model: string | undefined
  baseUrl: string | undefined
  apiKeyEnv: string | undefined
  template: string | undefined
  memory: boolean
  workspace: boolean
  skills: string[]
  rules: string[]
  mode: PermissionMode | undefined
} {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        name: { type: 'string' },
        role: { type: 'string' },
        instructions: { type: 'string' },
        seniority: { type: 'string' },
        driver: { type: 'string' },
        preset: { type: 'string' },
        model: { type: 'string' },
        'base-url': { type: 'string' },
        'api-key-env': { type: 'string' },
        template: { type: 'string' },
        memory: { type: 'boolean' },
        workspace: { type: 'boolean' },
        skill: { type: 'string', multiple: true },
        rule: { type: 'string', multiple: true },
        mode: { type: 'string' },
      },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('agents add: missing <id>')
  const name = parsed.values.name
  if (!name) usage('agents add: --name is required')

  const driver = parsed.values.driver ?? 'openai'
  if (!DRIVERS.includes(driver as (typeof DRIVERS)[number])) {
    usage(`agents add: --driver must be one of ${DRIVERS.join(', ')}`)
  }
  const preset = parsed.values.preset
  if (preset !== undefined && !PRESETS.includes(preset as (typeof PRESETS)[number])) {
    usage(`agents add: --preset must be one of ${PRESETS.join(', ')}`)
  }
  const mode = parsed.values.mode
  if (mode !== undefined && !MODES.includes(mode as PermissionMode)) {
    usage(`agents add: --mode must be one of ${MODES.join(', ')}`)
  }
  const apiKeyEnv = parsed.values['api-key-env']
  if (apiKeyEnv !== undefined && !API_KEY_ENV_RE.test(apiKeyEnv)) {
    usage('agents add: --api-key-env must match /^[A-Z][A-Z0-9_]*$/')
  }
  let seniority = 1
  const seniorityRaw = parsed.values.seniority
  if (seniorityRaw !== undefined) {
    const n = Number(seniorityRaw)
    if (!Number.isInteger(n)) usage('agents add: --seniority must be an integer')
    seniority = n
  }

  return {
    id,
    name,
    role: parsed.values.role,
    instructions: parsed.values.instructions,
    seniority,
    driver,
    preset,
    model: parsed.values.model,
    baseUrl: parsed.values['base-url'],
    apiKeyEnv,
    template: parsed.values.template,
    memory: parsed.values.memory === true,
    workspace: parsed.values.workspace === true,
    skills: parsed.values.skill ?? [],
    rules: parsed.values.rule ?? [],
    mode: mode as PermissionMode | undefined,
  }
}

function buildAgentSpec(opts: ReturnType<typeof parseAgentsAdd>): AgentSpec {
  if (!AGENT_ID_RE.test(opts.id)) {
    fail(`invalid agent id ${opts.id}`)
  }

  let driver: PluginRef
  if (opts.driver === 'stub') {
    const config: Record<string, unknown> = {}
    if (opts.template !== undefined) config.template = opts.template
    driver = { name: 'driver-stub', config }
  } else {
    if (!opts.model) fail('agents add: --model is required for the openai driver')
    if (!opts.preset && !opts.baseUrl) {
      fail('agents add: one of --preset or --base-url is required for the openai driver')
    }
    const config: Record<string, unknown> = { model: opts.model }
    if (opts.preset) config.preset = opts.preset
    if (opts.baseUrl) config.baseUrl = opts.baseUrl
    if (opts.apiKeyEnv) config.apiKeyEnv = opts.apiKeyEnv
    driver = { name: 'driver-openai-compat', config }
  }

  const plugins: PluginRef[] = []
  if (opts.memory) plugins.push({ name: 'memory' })
  if (opts.workspace) plugins.push({ name: 'workspace' })
  if (opts.skills.length > 0) plugins.push({ name: 'skills', config: { names: opts.skills } })

  const spec: AgentSpec = {
    id: opts.id,
    name: opts.name,
    seniority: opts.seniority,
    driver,
    plugins,
  }
  if (opts.role !== undefined) spec.role = opts.role
  if (opts.instructions !== undefined) spec.instructions = opts.instructions
  if (opts.rules.length > 0) spec.rules = opts.rules
  if (opts.mode !== undefined) spec.permissionMode = opts.mode
  return spec
}

async function cmdAgentsAdd(ctx: Ctx, args: string[]): Promise<number> {
  const opts = parseAgentsAdd(args)
  const existing = ctx.app.ctx.store.collection('agents').get(opts.id)
  if (existing) fail(`agent ${opts.id} already exists`)

  const spec = buildAgentSpec(opts)
  try {
    await ctx.app.ctx.agents.spawn(spec)
  } catch (err) {
    fail(errMessage(err))
  }
  await ctx.app.ctx.agents.dispose(spec.id)
  ctx.io.stdout.write(`added ${spec.id}\n`)
  return 0
}

/** Rejects any flag or positional for commands that take none. */
function noArgs(command: string, args: string[]): void {
  try {
    parseArgs({ args, allowPositionals: false, strict: true, options: {} })
  } catch (err) {
    usage(`${command}: ${errMessage(err)}`)
  }
}

function cmdAgentsList(ctx: Ctx, args: string[]): number {
  noArgs('agents list', args)
  const records = ctx.app.ctx.store.collection('agents').list()
  if (records.length === 0) {
    ctx.io.stdout.write('no agents\n')
    return 0
  }
  for (const rec of records) {
    const spec = rec.spec
    const driverName = spec.driver.name
    const model = spec.driver.config?.model
    const driverLabel = typeof model === 'string' ? `${driverName} ${model}` : driverName
    const role = spec.role ?? '-'
    ctx.io.stdout.write(`${spec.id}\t${spec.name}\t${driverLabel}\t${role}\n`)
  }
  return 0
}

function cmdAgentsShow(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('agents show: missing <id>')
  const rec = ctx.app.ctx.store.collection('agents').get(id)
  if (!rec) fail(`unknown agent ${id}`)
  ctx.io.stdout.write(`${JSON.stringify(rec.spec, null, 2)}\n`)
  return 0
}

async function cmdAgentsRemove(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { forget: { type: 'boolean' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('agents remove: missing <id>')
  const store = ctx.app.ctx.store
  const rec = store.collection('agents').get(id)
  if (!rec) fail(`unknown agent ${id}`)
  store.collection('agents').delete(id)
  if (parsed.values.forget === true) {
    store.collection('messages').clear(`agent:${id}`)
    store.collection('memories').clear(`agent:${id}`)
  }
  ctx.io.stdout.write(`removed ${id}\n`)
  return 0
}

async function cmdAgents(ctx: Ctx, args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'list') return cmdAgentsList(ctx, rest)
  if (sub === 'add') return cmdAgentsAdd(ctx, rest)
  if (sub === 'show') return cmdAgentsShow(ctx, rest)
  if (sub === 'remove') return cmdAgentsRemove(ctx, rest)
  usage(`agents: unknown subcommand ${sub ?? ''}`)
}

// ---------------------------------------------------------------------------
// ask / chat
// ---------------------------------------------------------------------------

async function cmdAsk(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('ask: missing <id>')
  const prompt = parsed.positionals.slice(1).join(' ')
  if (prompt.length === 0) usage('ask: missing <prompt>')

  const handle = await spawnStored(ctx, id)
  const result = await streamTurn(ctx, handle, prompt)
  return result.stopReason === 'end' ? 0 : 1
}

async function cmdChat(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('chat: missing <id>')

  const rec = ctx.app.ctx.store.collection('agents').get(id)
  if (!rec) fail(`unknown agent ${id}`)
  const handle = await spawnStored(ctx, id)
  ctx.io.stderr.write(`chatting with ${rec.spec.name} (/exit to quit)\n`)

  for (;;) {
    const line = await ctx.lines.next()
    if (line === undefined) break
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed === '/exit') break
    await streamTurn(ctx, handle, trimmed)
  }
  return 0
}

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

function cmdRulesList(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { agent: { type: 'string' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const agent = parsed.values.agent
  const rules = ctx.app.ctx.rules.list(agent ? `agent:${agent}` : undefined)
  // Rules written in the agent's spec are enforced live but not stored as records; show them too.
  const specRules = agent ? (ctx.app.ctx.store.collection('agents').get(agent)?.spec.rules ?? []) : []
  if (rules.length === 0 && specRules.length === 0) {
    ctx.io.stdout.write('no rules\n')
    return 0
  }
  for (const rule of rules) {
    ctx.io.stdout.write(`${rule.id}\t${rule.scope}\t${rule.sentence}\n`)
  }
  for (const sentence of specRules) {
    ctx.io.stdout.write(`(spec)\tagent:${agent}\t${sentence}\n`)
  }
  return 0
}

function cmdRulesAdd(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { agent: { type: 'string' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const sentence = parsed.positionals[0]
  if (!sentence) usage('rules add: missing "<sentence>"')
  const agent = parsed.values.agent
  let rule: Rule
  try {
    rule = ctx.app.ctx.rules.add(sentence, agent ? `agent:${agent}` : undefined)
  } catch (err) {
    fail(errMessage(err))
  }
  ctx.io.stdout.write(`added ${rule.id}\n`)
  return 0
}

function cmdRulesRemove(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('rules remove: missing <id>')
  const ok = ctx.app.ctx.rules.remove(id)
  if (!ok) fail(`unknown rule ${id}`)
  ctx.io.stdout.write(`removed ${id}\n`)
  return 0
}

async function cmdRules(ctx: Ctx, args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'list') return cmdRulesList(ctx, rest)
  if (sub === 'add') return cmdRulesAdd(ctx, rest)
  if (sub === 'remove') return cmdRulesRemove(ctx, rest)
  usage(`rules: unknown subcommand ${sub ?? ''}`)
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

async function cmdSkillsList(ctx: Ctx, args: string[]): Promise<number> {
  noArgs('skills list', args)
  const skills = await ctx.app.ctx.skills.list()
  if (skills.length === 0) {
    ctx.io.stdout.write('no skills\n')
    return 0
  }
  for (const skill of skills) {
    ctx.io.stdout.write(`${skill.name}\t${skill.description}\n`)
  }
  return 0
}

async function cmdSkillsPreview(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const source = parsed.positionals[0]
  if (!source) usage('skills preview: missing <source>')
  const preview = await ctx.app.ctx.skills.preview(source)
  ctx.io.stdout.write(`name: ${preview.name}\n`)
  ctx.io.stdout.write(`description: ${preview.description}\n`)
  ctx.io.stdout.write(`sha256: ${preview.hash}\n`)
  if (preview.existing) ctx.io.stdout.write(`replaces: ${preview.existing.name}\n`)
  ctx.io.stdout.write('\n')
  ctx.io.stdout.write(`${preview.body}\n`)
  return 0
}

async function cmdSkillsInstall(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { yes: { type: 'boolean' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const source = parsed.positionals[0]
  if (!source) usage('skills install: missing <source>')
  const preview = await ctx.app.ctx.skills.preview(source)
  ctx.io.stdout.write(`name: ${preview.name}\n`)
  ctx.io.stdout.write(`description: ${preview.description}\n`)
  ctx.io.stdout.write(`sha256: ${preview.hash}\n`)
  if (preview.existing) ctx.io.stdout.write(`replaces: ${preview.existing.name}\n`)
  ctx.io.stdout.write('\n')
  ctx.io.stdout.write(`${preview.body}\n`)

  if (parsed.values.yes !== true) {
    ctx.io.stderr.write(`install ${preview.name}? [y/N] `)
    const line = await ctx.lines.next()
    const answer = (line ?? '').trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') {
      ctx.io.stdout.write('cancelled\n')
      return 1
    }
  }
  const skill = await ctx.app.ctx.skills.install(source, preview.hash)
  ctx.io.stdout.write(`installed ${skill.name}\n`)
  return 0
}

async function cmdSkillsRemove(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const name = parsed.positionals[0]
  if (!name) usage('skills remove: missing <name>')
  const ok = await ctx.app.ctx.skills.remove(name)
  if (!ok) fail(`unknown skill ${name}`)
  ctx.io.stdout.write(`removed ${name}\n`)
  return 0
}

async function cmdSkills(ctx: Ctx, args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'list') return cmdSkillsList(ctx, rest)
  if (sub === 'preview') return cmdSkillsPreview(ctx, rest)
  if (sub === 'install') return cmdSkillsInstall(ctx, rest)
  if (sub === 'remove') return cmdSkillsRemove(ctx, rest)
  usage(`skills: unknown subcommand ${sub ?? ''}`)
}

// ---------------------------------------------------------------------------
// routines
// ---------------------------------------------------------------------------

function cmdRoutinesList(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { agent: { type: 'string' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const routines = ctx.app.ctx.routines.list(parsed.values.agent)
  if (routines.length === 0) {
    ctx.io.stdout.write('no routines\n')
    return 0
  }
  for (const routine of routines) {
    const state = routine.enabled ? 'enabled' : 'disabled'
    const prompt = routine.prompt.slice(0, 60)
    ctx.io.stdout.write(
      `${routine.id}\t${routine.agentId}\tevery ${routine.everyMinutes}m\t${state}\t${prompt}\n`,
    )
  }
  return 0
}

function cmdRoutinesAdd(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        every: { type: 'string' },
        prompt: { type: 'string' },
        quiet: { type: 'boolean' },
        window: { type: 'string' },
        tz: { type: 'string' },
        days: { type: 'string' },
        disabled: { type: 'boolean' },
      },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const agentId = parsed.positionals[0]
  if (!agentId) usage('routines add: missing <agentId>')
  const everyRaw = parsed.values.every
  if (!everyRaw) usage('routines add: --every is required')
  const everyMinutes = Number(everyRaw)
  if (!Number.isInteger(everyMinutes)) usage('routines add: --every must be an integer')
  const prompt = parsed.values.prompt
  if (!prompt) usage('routines add: --prompt is required')

  const rec = ctx.app.ctx.store.collection('agents').get(agentId)
  if (!rec) fail(`unknown agent ${agentId}`)

  let window: Routine['window']
  const windowRaw = parsed.values.window
  if (windowRaw !== undefined) {
    const parts = windowRaw.split('-')
    const start = parts[0]
    const end = parts[1]
    if (!start || !end) usage('routines add: --window must be HH:MM-HH:MM')
    window = { start, end }
    const tz = parsed.values.tz
    if (tz !== undefined) window.tz = tz
    const daysRaw = parsed.values.days
    if (daysRaw !== undefined) {
      const days = daysRaw.split(',').map((d) => Number(d.trim()))
      if (days.some((d) => !Number.isInteger(d))) usage('routines add: --days must be a comma list of integers')
      window.days = days
    }
  }

  let routine: Routine
  try {
    routine = ctx.app.ctx.routines.add({
      agentId,
      prompt,
      everyMinutes,
      quiet: parsed.values.quiet === true,
      enabled: parsed.values.disabled !== true,
      ...(window ? { window } : {}),
    })
  } catch (err) {
    fail(errMessage(err))
  }
  ctx.io.stdout.write(`added ${routine.id}\n`)
  return 0
}

function cmdRoutinesRemove(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('routines remove: missing <id>')
  const ok = ctx.app.ctx.routines.remove(id)
  if (!ok) fail(`unknown routine ${id}`)
  ctx.io.stdout.write(`removed ${id}\n`)
  return 0
}

async function cmdRoutinesRun(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {} })
  } catch (err) {
    usage(errMessage(err))
  }
  const id = parsed.positionals[0]
  if (!id) usage('routines run: missing <id>')
  const routine = ctx.app.ctx.routines.list().find((r) => r.id === id)
  if (!routine) fail(`unknown routine ${id}`)
  await spawnStored(ctx, routine.agentId)
  const run = await ctx.app.ctx.routines.runNow(id)
  if (run.error) {
    ctx.io.stderr.write(`error: ${run.error}\n`)
    return 1
  }
  if (run.silent || run.output.length === 0) {
    ctx.io.stdout.write('(silent)\n')
  } else {
    ctx.io.stdout.write(`${run.output}\n`)
  }
  return 0
}

async function cmdRoutines(ctx: Ctx, args: string[]): Promise<number> {
  const sub = args[0]
  const rest = args.slice(1)
  if (sub === 'list') return cmdRoutinesList(ctx, rest)
  if (sub === 'add') return cmdRoutinesAdd(ctx, rest)
  if (sub === 'remove') return cmdRoutinesRemove(ctx, rest)
  if (sub === 'run') return cmdRoutinesRun(ctx, rest)
  usage(`routines: unknown subcommand ${sub ?? ''}`)
}

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

function cmdApprovals(ctx: Ctx, args: string[]): number {
  let parsed
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: { all: { type: 'boolean' } },
    })
  } catch (err) {
    usage(errMessage(err))
  }
  const records = ctx.app.ctx.store
    .collection('approvals')
    .list({ order: 'desc', limit: 50 })
  const filtered = parsed.values.all === true ? records : records
  if (filtered.length === 0) {
    ctx.io.stdout.write('no approvals\n')
    return 0
  }
  for (const rec of filtered) {
    const iso = new Date(rec.createdAt).toISOString()
    ctx.io.stdout.write(`${iso}\t${rec.status}\t${rec.action.agentId}\t${rec.action.kind} ${rec.action.target}\n`)
  }
  return 0
}

// ---------------------------------------------------------------------------
// daemon
// ---------------------------------------------------------------------------

async function cmdDaemon(ctx: Ctx): Promise<number> {
  const restored = await ctx.app.ctx.agents.restore()
  for (const id of restored.ok) ctx.io.stderr.write(`started ${id}\n`)
  for (const failure of restored.failed) {
    ctx.io.stderr.write(`failed ${failure.id}: ${failure.error}\n`)
  }

  ctx.app.ctx.on('whales/routine-ran', (run) => {
    if (run.silent) return
    const iso = new Date(run.finishedAt).toISOString()
    if (run.error) {
      ctx.io.stdout.write(`[${iso}] ${run.agentId}: error: ${run.error}\n`)
    } else {
      ctx.io.stdout.write(`[${iso}] ${run.agentId}: ${run.output}\n`)
    }
  })

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      process.off('SIGINT', finish)
      process.off('SIGTERM', finish)
      resolve()
    }
    process.once('SIGINT', finish)
    process.once('SIGTERM', finish)
    void (async () => {
      for (;;) {
        const line = await ctx.lines.next()
        if (line === undefined) break
      }
      finish()
    })()
  })
  return 0
}

// ---------------------------------------------------------------------------
// serve
// ---------------------------------------------------------------------------

async function cmdServe(ctx: Ctx, args: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args, allowPositionals: false, strict: true, options: { port: { type: 'string' }, host: { type: 'string' }, dev: { type: 'boolean' } } })
  } catch (err) {
    usage(`serve: ${errMessage(err)}`)
  }
  const port = parsed.values.port === undefined ? undefined : Number(parsed.values.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) usage('serve: --port must be 0..65535')
  const restored = await ctx.app.ctx.agents.restore()
  for (const failure of restored.failed) ctx.io.stderr.write(`failed ${failure.id}: ${failure.error}\n`)
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  const server = await startServer(ctx.app, {
    ...(parsed.values.host ? { host: parsed.values.host } : {}),
    ...(port !== undefined ? { port } : {}),
    env: ctx.io.env,
    ...(existsSync(webDist) ? { staticDir: webDist } : {}),
    ...(parsed.values.dev ? { devOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'] } : {}),
  })
  ctx.io.stderr.write(`whales API on ${server.url} (${restored.ok.length} agents running)\n`)
  ctx.io.stderr.write(existsSync(webDist) ? `open the UI: ${server.uiUrl}\n` : 'web UI not built: run `pnpm --filter whales-web build`\n')
  if (server.tokenSource === 'generated') ctx.io.stderr.write('(a new token is generated on every start; set WHALES_API_TOKEN to keep one)\n')
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off('SIGINT', stop)
      process.off('SIGTERM', stop)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await server.close()
  return 0
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

async function dispatch(ctx: Ctx, argv: string[]): Promise<number> {
  const command = argv[0]
  const rest = argv.slice(1)
  switch (command) {
    case 'agents':
      return cmdAgents(ctx, rest)
    case 'ask':
      return cmdAsk(ctx, rest)
    case 'chat':
      return cmdChat(ctx, rest)
    case 'rules':
      return cmdRules(ctx, rest)
    case 'skills':
      return cmdSkills(ctx, rest)
    case 'routines':
      return cmdRoutines(ctx, rest)
    case 'serve':
      return cmdServe(ctx, rest)
    case 'backup':
      return cmdBackup(ctx, rest)
    case 'checkpoints':
      return cmdCheckpoints(ctx, rest)
    case 'rooms':
      return cmdRooms(ctx, rest)
    case 'team':
      return cmdTeam(ctx, rest)
    case 'approvals':
      return cmdApprovals(ctx, rest)
    case 'daemon':
      noArgs('daemon', rest)
      return cmdDaemon(ctx)
    default:
      usage(`unknown command ${command ?? ''}`)
  }
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  const command = argv[0]
  if (command === undefined || command === 'help' || command === '--help') {
    io.stdout.write(USAGE)
    return 0
  }

  const lines = new LineReader(io.stdin)
  let app: App | undefined
  try {
    const config = await loadConfig({ env: io.env, cwd: io.cwd })
    await fs.mkdir(config.dataDir, { recursive: true })
    // Restore replaces the database, so it must run before the app opens it.
    if (command === 'restore') return await cmdRestore(io, lines, config, argv.slice(1))
    app = await createApp({
      config,
      storePath: path.join(config.dataDir, 'whales.db'),
    })
    const ctx: Ctx = { io, lines, app }
    // In serve mode approvals are answered in the web UI; a terminal prompt reading a closed stdin would
    // deny every request instantly.
    if (command !== 'serve') installApprovalHandler(ctx)
    return await dispatch(ctx, argv)
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`${err.message}\n`)
      return 2
    }
    if (err instanceof ConfigError || err instanceof CliError) {
      io.stderr.write(`error: ${err.message}\n`)
      return 1
    }
    io.stderr.write(`error: ${errMessage(err)}\n`)
    return 1
  } finally {
    lines.close()
    if (app) await app.stop()
  }
}
