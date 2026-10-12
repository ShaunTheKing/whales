import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from 'cordis'
import type {} from '../../src/contracts/index.ts'
import type { DriverEvent, TurnInput } from '../../src/contracts/index.ts'
import type { ToolSet } from '../../src/contracts/tools.ts'
import OpenAICompatDriver, { buildBody, PRESETS } from '../../src/drivers/openai-compat.ts'
import type { OpenAICompatConfig } from '../../src/drivers/openai-compat.ts'

const KEY_ENV = 'WHALES_TEST_KEY'
const KEY_VALUE = 'sk-test-SECRET-123'

interface Scripted {
  status?: number
  headers?: Record<string, string>
  chunks?: string[]
  chunkDelayMs?: number
  hang?: boolean
  body?: string
}

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

const queue: Scripted[] = []
const requests: RecordedRequest[] = []
const sockets = new Set<import('node:net').Socket>()

let server: http.Server
let port = 0

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

const DONE = 'data: [DONE]\n\n'

function delta(content: string): string {
  return sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })
}

function reasoningDelta(content: string): string {
  return sse({ choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }] })
}

function finish(reason: string): string {
  return sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
}

function usageChunk(prompt: number, completion: number): string {
  return sse({
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => parts.push(c))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function parseBody(raw: string): unknown {
  if (raw.length === 0) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

before(async () => {
  process.env[KEY_ENV] = KEY_VALUE
  server = http.createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req)
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ')
      }
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers,
        body: parseBody(raw),
      })

      const scripted = queue.shift() ?? { status: 200, chunks: [DONE] }
      const status = scripted.status ?? 200
      const outHeaders: Record<string, string> = { ...(scripted.headers ?? {}) }
      if (status === 200) {
        outHeaders['content-type'] = outHeaders['content-type'] ?? 'text/event-stream'
      }
      res.writeHead(status, outHeaders)

      if (status !== 200) {
        res.end(scripted.body ?? '')
        return
      }

      const chunks = scripted.chunks ?? []
      for (const chunk of chunks) {
        if (scripted.chunkDelayMs && scripted.chunkDelayMs > 0) {
          await delay(scripted.chunkDelayMs)
        }
        res.write(chunk)
      }

      if (scripted.hang) {
        return
      }
      res.end()
    })().catch(() => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port
      resolve()
    })
  })
})

after(async () => {
  delete process.env[KEY_ENV]
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  queue.length = 0
  requests.length = 0
})

const emptyToolSet: ToolSet = {
  specs: [],
  invoke: async () => ({ output: '', isError: true }),
}

function makeInput(prompt = 'hi', system = 'sys'): TurnInput {
  return {
    turnId: 't1',
    system,
    history: [],
    prompt,
    tools: emptyToolSet,
  }
}

async function collect(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const events: DriverEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

function doneEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'done' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'done' }> => e.type === 'done')
}

function errorEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'error' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'error' }> => e.type === 'error')
}

function textDeltas(events: DriverEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) if (ev.type === 'text') out.push(ev.delta)
  return out
}

function thinkingDeltas(events: DriverEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) if (ev.type === 'thinking') out.push(ev.delta)
  return out
}

function usageEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'usage' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'usage' }> => e.type === 'usage')
}

function baseUrl(): string {
  return `http://127.0.0.1:${port}/v1`
}

async function withDriver(
  cfg: Record<string, unknown>,
  fn: (d: OpenAICompatDriver) => Promise<void>,
): Promise<void> {
  const app = new Context()
  // Tests deliberately pass invalid configs; the driver validates at runtime.
  const fiber = app.plugin(OpenAICompatDriver, cfg as unknown as OpenAICompatConfig)
  try {
    await fiber
    const d = app.get('driver')
    assert.ok(d instanceof OpenAICompatDriver)
    await fn(d)
  } finally {
    await fiber.dispose()
  }
}

async function rejectsConfig(cfg: Record<string, unknown>): Promise<void> {
  const app = new Context()
  // Tests deliberately pass invalid configs; the driver validates at runtime.
  const fiber = app.plugin(OpenAICompatDriver, cfg as unknown as OpenAICompatConfig)
  await assert.rejects(Promise.resolve(fiber))
  await fiber.dispose()
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

describe('OpenAICompatDriver config', () => {
  test('defaults: kind, model, capabilities, endpoint', async () => {
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      assert.equal(d.kind, 'openai-compat')
      assert.equal(d.model, 'm1')
      assert.deepEqual(d.capabilities, {
        tools: true,
        agentic: false,
        statefulSession: false,
      })
      assert.equal(d.endpoint, `http://127.0.0.1:${port}/v1/chat/completions`)
    })
  })

  test('trailing slashes on baseUrl are stripped', async () => {
    await withDriver(
      { baseUrl: `http://127.0.0.1:${port}/v1///`, model: 'm1', apiKeyEnv: KEY_ENV },
      async (d) => {
        assert.equal(d.endpoint, `http://127.0.0.1:${port}/v1/chat/completions`)
      },
    )
  })

  test('PRESETS values match the spec', () => {
    assert.deepEqual(PRESETS.deepseek, {
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
    })
    assert.deepEqual(PRESETS.openai, {
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
    })
    assert.deepEqual(PRESETS.openrouter, {
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
    })
    assert.deepEqual(PRESETS.ollama, { baseUrl: 'http://127.0.0.1:11434/v1' })
  })

  test('preset deepseek resolves endpoint', async () => {
    await withDriver(
      { preset: 'deepseek', model: 'deepseek-chat', apiKeyEnv: KEY_ENV },
      async (d) => {
        assert.equal(d.endpoint, 'https://api.deepseek.com/chat/completions')
      },
    )
  })

  test('preset ollama without key constructs', async () => {
    await withDriver({ preset: 'ollama', model: 'llama3' }, async (d) => {
      assert.equal(d.endpoint, 'http://127.0.0.1:11434/v1/chat/completions')
    })
  })

  test('rejects missing model', async () => {
    await rejectsConfig({ baseUrl: baseUrl() })
  })

  test('rejects empty model', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: '' })
  })

  test('rejects unknown preset', async () => {
    await rejectsConfig({ preset: 'nope', model: 'm1' })
  })

  test('rejects no preset and no baseUrl', async () => {
    await rejectsConfig({ model: 'm1' })
  })

  test('rejects ftp baseUrl', async () => {
    await rejectsConfig({ baseUrl: 'ftp://x', model: 'm1' })
  })

  test('rejects baseUrl with credentials', async () => {
    await rejectsConfig({ baseUrl: 'https://u:p@h', model: 'm1' })
  })

  test('rejects baseUrl with query', async () => {
    await rejectsConfig({ baseUrl: 'https://h/?a=1', model: 'm1' })
  })

  test('rejects baseUrl with hash', async () => {
    await rejectsConfig({ baseUrl: 'https://h/#frag', model: 'm1' })
  })

  test('rejects lower_case apiKeyEnv', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: 'lower_case' })
  })

  test('rejects temperature 3', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', temperature: 3 })
  })

  test('rejects maxTokens 0', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxTokens: 0 })
  })

  test('rejects maxTokens 1.5', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxTokens: 1.5 })
  })

  test('rejects idleTimeoutMs 0', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', idleTimeoutMs: 0 })
  })

  test('rejects maxRetries 6', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxRetries: 6 })
  })

  test('rejects maxRetries 1.5', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxRetries: 1.5 })
  })
})

describe('OpenAICompatDriver security', () => {
  test('apiKeyEnv + http non-loopback host rejects', async () => {
    await rejectsConfig({ baseUrl: 'http://example.com', model: 'm1', apiKeyEnv: KEY_ENV })
  })

  test('apiKeyEnv + http localhost accepted', async () => {
    await withDriver(
      { baseUrl: 'http://localhost:1234', model: 'm1', apiKeyEnv: KEY_ENV },
      async (d) => {
        assert.equal(d.endpoint, 'http://localhost:1234/chat/completions')
      },
    )
  })

  test('apiKeyEnv + http [::1] accepted', async () => {
    await withDriver(
      { baseUrl: 'http://[::1]:1234', model: 'm1', apiKeyEnv: KEY_ENV },
      async (d) => {
        assert.equal(d.endpoint, 'http://[::1]:1234/chat/completions')
      },
    )
  })

  test('no apiKeyEnv + http example.com accepted', async () => {
    await withDriver({ baseUrl: 'http://example.com', model: 'm1' }, async (d) => {
      assert.equal(d.endpoint, 'http://example.com/chat/completions')
    })
  })

  test('apiKeyEnv pointing to unset variable rejects', async () => {
    const app = new Context()
    const fiber = app.plugin(OpenAICompatDriver, {
      baseUrl: baseUrl(),
      model: 'm1',
      apiKeyEnv: 'WHALES_TEST_UNSET',
    })
    await assert.rejects(Promise.resolve(fiber), (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      assert.ok(msg.includes('WHALES_TEST_UNSET'), msg)
      assert.ok(msg.includes('not set'), msg)
      return true
    })
    await fiber.dispose()
  })

  test('key value is not stored on the instance', async () => {
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const entries = Object.getOwnPropertyNames(d).map((name) => {
        const value = Reflect.get(d, name)
        return [name, String(value)] as const
      })
      assert.ok(!JSON.stringify(entries).includes(KEY_VALUE))
      for (const [, value] of entries) {
        assert.ok(!value.includes(KEY_VALUE))
      }
    })
  })
})

describe('buildBody', () => {
  test('system first, history with name prefix, then prompt', () => {
    const input: TurnInput = {
      turnId: 't1',
      system: 'sys',
      history: [
        { role: 'user', content: 'hello', name: 'alice' },
        { role: 'assistant', content: 'hi there' },
      ],
      prompt: 'next',
      tools: emptyToolSet,
    }
    const body = buildBody({ baseUrl: baseUrl(), model: 'm1' }, input)
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'alice: hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'next' },
    ])
    const messages = body.messages as Array<Record<string, unknown>>
    assert.ok(!('name' in (messages[1] ?? {})))
    assert.equal(body.stream, true)
    assert.deepEqual(body.stream_options, { include_usage: true })
    assert.equal(body.model, 'm1')
  })

  test('empty system omitted', () => {
    const input: TurnInput = {
      turnId: 't1',
      system: '',
      history: [],
      prompt: 'hi',
      tools: emptyToolSet,
    }
    const body = buildBody({ baseUrl: baseUrl(), model: 'm1' }, input)
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }])
  })

  test('temperature and max_tokens only when configured', () => {
    const input = makeInput()
    const bare = buildBody({ baseUrl: baseUrl(), model: 'm1' }, input)
    assert.ok(!('temperature' in bare))
    assert.ok(!('max_tokens' in bare))

    const configured = buildBody(
      { baseUrl: baseUrl(), model: 'm1', temperature: 0.5, maxTokens: 128 },
      input,
    )
    assert.equal(configured.temperature, 0.5)
    assert.equal(configured.max_tokens, 128)
  })
})

describe('OpenAICompatDriver request', () => {
  test('POST with auth, content-type, accept and body', async () => {
    queue.push({ status: 200, chunks: [delta('ok'), DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      await collect(d.run(makeInput('hi', 'sys'), new AbortController().signal))
    })
    assert.equal(requests.length, 1)
    const req = requests[0]
    assert.ok(req)
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, `Bearer ${KEY_VALUE}`)
    assert.equal(req.headers['content-type'], 'application/json')
    assert.equal(req.headers.accept, 'text/event-stream')
    const body = req.body as Record<string, unknown>
    assert.equal(body.model, 'm1')
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('no apiKeyEnv → no authorization header', async () => {
    queue.push({ status: 200, chunks: [delta('ok'), DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1' }, async (d) => {
      await collect(d.run(makeInput(), new AbortController().signal))
    })
    assert.equal(requests.length, 1)
    const req = requests[0]
    assert.ok(req)
    assert.equal(req.headers.authorization, undefined)
  })
})

describe('OpenAICompatDriver streaming', () => {
  test('text deltas, usage before done, done{end} last', async () => {
    queue.push({
      status: 200,
      chunks: [
        delta('Hello'),
        delta(' world'),
        finish('stop'),
        usageChunk(7, 3),
        DONE,
      ],
    })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(textDeltas(events).join(''), 'Hello world')
      const usage = usageEvents(events)
      assert.equal(usage.length, 1)
      assert.equal(usage[0]?.inputTokens, 7)
      assert.equal(usage[0]?.outputTokens, 3)
      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(done[0]?.stopReason, 'end')
      assert.equal(events.at(-1)?.type, 'done')
      const usageIndex = events.findIndex((e) => e.type === 'usage')
      const doneIndex = events.findIndex((e) => e.type === 'done')
      assert.ok(usageIndex >= 0 && usageIndex < doneIndex)
    })
  })

  test('reasoning_content and reasoning → thinking events', async () => {
    queue.push({
      status: 200,
      chunks: [
        reasoningDelta('think-a'),
        sse({ choices: [{ index: 0, delta: { reasoning: 'think-b' }, finish_reason: null }] }),
        delta('answer'),
        DONE,
      ],
    })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.deepEqual(thinkingDeltas(events), ['think-a', 'think-b'])
      assert.equal(textDeltas(events).join(''), 'answer')
    })
  })

  test('finish_reason length → max_tokens', async () => {
    queue.push({ status: 200, chunks: [delta('x'), finish('length'), DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(doneEvents(events)[0]?.stopReason, 'max_tokens')
    })
  })

  test('finish_reason content_filter → refused', async () => {
    queue.push({ status: 200, chunks: [delta('x'), finish('content_filter'), DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(doneEvents(events)[0]?.stopReason, 'refused')
    })
  })

  test('no finish_reason → end', async () => {
    queue.push({ status: 200, chunks: [delta('x'), DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(doneEvents(events)[0]?.stopReason, 'end')
    })
  })

  test('keep-alive comments and CRLF tolerated', async () => {
    queue.push({
      status: 200,
      chunks: [
        ': OPENROUTER PROCESSING\n\n',
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }) + '\r\n\r\n',
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'b' }, finish_reason: null }] }) + '\r\n\r\n',
        DONE,
      ],
    })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(textDeltas(events).join(''), 'ab')
      assert.equal(doneEvents(events)[0]?.stopReason, 'end')
    })
  })

  test('JSON event split across two chunks parses', async () => {
    const line = 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'split' }, finish_reason: null }] }) + '\n\n'
    const mid = Math.floor(line.length / 2)
    queue.push({
      status: 200,
      chunkDelayMs: 5,
      chunks: [line.slice(0, mid), line.slice(mid), DONE],
    })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(textDeltas(events).join(''), 'split')
    })
  })

  test('body ending without [DONE] still yields done', async () => {
    queue.push({ status: 200, chunks: [delta('partial'), finish('stop')] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      assert.equal(textDeltas(events).join(''), 'partial')
      assert.equal(doneEvents(events)[0]?.stopReason, 'end')
    })
  })

  test('streamed error object → error then done{error}', async () => {
    queue.push({
      status: 200,
      chunks: [sse({ error: { message: 'overloaded' } }), DONE],
    })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      const errs = errorEvents(events)
      assert.equal(errs.length, 1)
      assert.ok(errs[0]?.message.includes('overloaded'))
      assert.equal(doneEvents(events)[0]?.stopReason, 'error')
    })
  })

  test('invalid JSON line → error invalid stream data', async () => {
    queue.push({ status: 200, chunks: ['data: {not json\n\n', DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput(), new AbortController().signal))
      const errs = errorEvents(events)
      assert.equal(errs.length, 1)
      assert.equal(errs[0]?.message, 'invalid stream data')
      assert.equal(doneEvents(events)[0]?.stopReason, 'error')
    })
  })
})

describe('OpenAICompatDriver errors and retry', () => {
  test('401 no retry, error message includes status and body message', async () => {
    queue.push({
      status: 401,
      body: JSON.stringify({ error: { message: 'bad key' } }),
    })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxRetries: 2 },
      async (d) => {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        assert.equal(requests.length, 1)
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        assert.ok(errs[0]?.message.includes('HTTP 401'))
        assert.ok(errs[0]?.message.includes('bad key'))
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
      },
    )
  })

  test('503 then 200 retries once', async () => {
    queue.push({ status: 503, headers: { 'retry-after': '0' }, body: 'busy' })
    queue.push({ status: 200, chunks: [delta('recovered'), DONE] })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxRetries: 1 },
      async (d) => {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        assert.equal(requests.length, 2)
        assert.equal(textDeltas(events).join(''), 'recovered')
        assert.equal(doneEvents(events)[0]?.stopReason, 'end')
      },
    )
  })

  test('429 three times exhausts retries', async () => {
    queue.push({ status: 429, headers: { 'retry-after': '0' }, body: 'slow down' })
    queue.push({ status: 429, headers: { 'retry-after': '0' }, body: 'slow down' })
    queue.push({ status: 429, headers: { 'retry-after': '0' }, body: 'slow down' })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxRetries: 2 },
      async (d) => {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        assert.equal(requests.length, 3)
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        assert.ok(errs[0]?.message.includes('HTTP 429'))
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
      },
    )
  })

  test('500 body containing key is redacted', async () => {
    queue.push({ status: 500, body: `server error ${KEY_VALUE}` })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxRetries: 0 },
      async (d) => {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        const msg = errs[0]?.message ?? ''
        assert.ok(msg.includes('[redacted]'), msg)
        assert.ok(!msg.includes(KEY_VALUE), msg)
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
      },
    )
  })

  test('network error to closed port resolves with error', async () => {
    const closed = await freePort()
    await withDriver(
      { baseUrl: `http://127.0.0.1:${closed}/v1`, model: 'm1', maxRetries: 0 },
      async (d) => {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        assert.ok(errs[0]?.message.includes('failed'))
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
      },
    )
  })
})

describe('OpenAICompatDriver abort and timeout', () => {
  test('pre-aborted signal → only done{cancelled}, no request', async () => {
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const ac = new AbortController()
      ac.abort()
      const events = await collect(d.run(makeInput(), ac.signal))
      assert.equal(events.length, 1)
      assert.equal(events[0]?.type, 'done')
      assert.equal(doneEvents(events)[0]?.stopReason, 'cancelled')
    })
    assert.equal(requests.length, 0)
  })

  test('abort mid-stream → done{cancelled}, no error', async () => {
    queue.push({ status: 200, chunks: [delta('first')], hang: true })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const ac = new AbortController()
      const events: DriverEvent[] = []
      for await (const ev of d.run(makeInput(), ac.signal)) {
        events.push(ev)
        if (ev.type === 'text') ac.abort()
      }
      assert.equal(errorEvents(events).length, 0)
      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(done[0]?.stopReason, 'cancelled')
      assert.equal(events.at(-1)?.type, 'done')
    })
  })

  test('idle timeout fires quickly', async () => {
    queue.push({ status: 200, chunks: [], hang: true })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, idleTimeoutMs: 50, maxRetries: 0 },
      async (d) => {
        const start = Date.now()
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        const elapsed = Date.now() - start
        assert.ok(elapsed < 1000, `elapsed ${elapsed}`)
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        assert.ok(errs[0]?.message.includes('no data'))
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
      },
    )
  })

  test('steady stream longer than idleTimeoutMs does not time out', async () => {
    // 8 chunks 30ms apart = ~240ms total, idle limit 100ms: only silence may trip the timer.
    queue.push({ status: 200, chunkDelayMs: 30, chunks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(delta).concat(DONE) })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, idleTimeoutMs: 100, maxRetries: 0 },
      async (d) => {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        assert.equal(errorEvents(events).length, 0)
        assert.equal(textDeltas(events).join(''), 'abcdefg')
        assert.equal(doneEvents(events)[0]?.stopReason, 'end')
      },
    )
  })

  test('env var deleted after construction → error, no request', async () => {
    const app = new Context()
    const fiber = app.plugin(OpenAICompatDriver, {
      baseUrl: baseUrl(),
      model: 'm1',
      apiKeyEnv: KEY_ENV,
    })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof OpenAICompatDriver)
      const saved = process.env[KEY_ENV]
      delete process.env[KEY_ENV]
      try {
        const events = await collect(d.run(makeInput(), new AbortController().signal))
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        assert.ok(errs[0]?.message.includes('not set'))
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
        assert.equal(requests.length, 0)
      } finally {
        if (saved !== undefined) process.env[KEY_ENV] = saved
      }
    } finally {
      await fiber.dispose()
    }
  })
})
