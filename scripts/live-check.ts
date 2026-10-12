// One real round-trip through an agent using driver-openai-compat.
// THIS SPENDS MONEY when pointed at a paid API. Output is capped by --max-tokens (default 64).
//
//   node scripts/live-check.ts --preset deepseek --model deepseek-chat "Reply with exactly: pong"
//   node scripts/live-check.ts --base-url http://127.0.0.1:11434/v1 --model llama3.2   (Ollama, free)
//
// The API key is read from the preset's env var (e.g. DEEPSEEK_API_KEY) or --api-key-env NAME.
// Only whether it is set is printed, never its value.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import type {} from '../src/contracts/index.ts'
import { createApp } from '../src/core/app.ts'
import { defaultConfig } from '../src/core/config.ts'
import { PRESETS, type Preset } from '../src/drivers/openai-compat.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    preset: { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    'api-key-env': { type: 'string' },
    'max-tokens': { type: 'string', default: '64' },
  },
})

const prompt = positionals.join(' ') || 'Reply with exactly: pong'
const preset = values.preset as Preset | undefined
if (preset !== undefined && !(preset in PRESETS)) throw new Error(`unknown preset ${preset}; one of ${Object.keys(PRESETS).join(', ')}`)
if (!values.model) throw new Error('--model is required')
const maxTokens = Number(values['max-tokens'])
const keyEnv = values['api-key-env'] ?? (preset ? PRESETS[preset].apiKeyEnv : undefined)

const driverConfig: Record<string, unknown> = { model: values.model, maxTokens, maxRetries: 0 }
if (preset) driverConfig.preset = preset
if (values['base-url']) driverConfig.baseUrl = values['base-url']
if (values['api-key-env']) driverConfig.apiKeyEnv = values['api-key-env']

console.error(`endpoint : ${values['base-url'] ?? (preset ? PRESETS[preset].baseUrl : '?')}`)
console.error(`model    : ${values.model} (max ${maxTokens} output tokens)`)
console.error(`api key  : ${keyEnv ? `${keyEnv} is ${process.env[keyEnv] ? 'set' : 'NOT set'}` : 'none'}`)
console.error(`prompt   : ${prompt}\n`)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-live-'))
const app = await createApp({ config: defaultConfig({ env: {}, home, cwd: home }), storePath: ':memory:' })
let failed = false
try {
  const handle = await app.ctx.agents.spawn(
    { id: 'live', name: 'Live', seniority: 1, driver: { name: 'driver-openai-compat', config: driverConfig }, plugins: [] },
    { persist: false },
  )
  if (!handle.runtime) throw new Error('agent did not start')
  const started = Date.now()
  for await (const event of handle.runtime.turn(prompt)) {
    if (event.type === 'text') process.stdout.write(event.delta)
    else if (event.type === 'thinking') process.stderr.write('.')
    else if (event.type === 'usage') console.error(`\n\nusage    : ${event.inputTokens} in / ${event.outputTokens} out`)
    else if (event.type === 'error') { failed = true; console.error(`\nerror    : ${event.message}`) }
    else if (event.type === 'done') {
      if (event.stopReason !== 'end') failed = true
      console.error(`done     : ${event.stopReason} in ${Date.now() - started}ms`)
    }
  }
} catch (err) {
  failed = true
  console.error(`failed   : ${err instanceof Error ? err.message : String(err)}`)
} finally {
  await app.stop()
  fs.rmSync(home, { recursive: true, force: true })
}
process.exitCode = failed ? 1 : 0
