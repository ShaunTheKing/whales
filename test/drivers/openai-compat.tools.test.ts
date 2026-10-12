import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from 'cordis'
import type {} from '../../src/contracts/index.ts'
import type { DriverEvent, TurnInput } from '../../src/contracts/index.ts'
import type { ToolCall, ToolResult, ToolSet } from '../../src/contracts/tools.ts'
import OpenAICompatDriver from '../../src/drivers/openai-compat.ts'
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

function finish(reason: string): string {
  return sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
}

function usageChunk(prompt: number, completion: number): string {
  return sse({
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  })
}

interface ToolCallFragment {
  id?: string
  name?: string
  args?: string
}

function toolCallChunk(index: number, fragment: ToolCallFragment): string {
  const fn: Record<string, unknown> = {}
  if (fragment.name !== undefined) fn.name = fragment.name
  if (fragment.args !== undefined) fn.arguments = fragment.args
  const call: Record<string, unknown> = { index, type: 'function', function: fn }
  if (fragment.id !== undefined) call.id = fragment.id
  return sse({
    choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
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

interface RecordingTools {
  set: ToolSet
  calls: ToolCall[]
}

function makeTools(
  handlers: Record<string, (input: unknown) => ToolResult | Promise<ToolResult>>,
): RecordingTools {
  const names = Object.keys(handlers)
  const calls: ToolCall[] = []
  const set: ToolSet = {
    specs: names.map((n) => ({
      name: n,
      description: n + ' tool',
      inputSchema: { type: 'object', properties: {} },
    })),
    invoke: async (call: ToolCall, _signal: AbortSignal): Promise<ToolResult> => {
      calls.push(call)
      const handler = handlers[call.name]
      if (!handler) return { output: `unknown tool ${call.name}`, isError: true }
      return handler(call.input)
    },
  }
  return { set, calls }
}

function makeInput(prompt = 'hi', system = 'sys', tools?: ToolSet): TurnInput {
  return {
    turnId: 't1',
    system,
    history: [],
    prompt,
    tools: tools ?? { specs: [], invoke: async () => ({ output: '', isError: true }) },
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

function usageEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'usage' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'usage' }> => e.type === 'usage')
}

function toolCallEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'tool_call' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'tool_call' }> => e.type === 'tool_call')
}

function toolResultEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'tool_result' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'tool_result' }> => e.type === 'tool_result')
}

function baseUrl(): string {
  return `http://127.0.0.1:${port}/v1`
}

async function withDriver(
  cfg: Record<string, unknown>,
  fn: (d: OpenAICompatDriver) => Promise<void>,
): Promise<void> {
  const app = new Context()
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
  const fiber = app.plugin(OpenAICompatDriver, cfg as unknown as OpenAICompatConfig)
  await assert.rejects(Promise.resolve(fiber))
  await fiber.dispose()
}

function bodyOf(index: number): Record<string, unknown> {
  const req = requests[index]
  assert.ok(req, `request ${index} missing`)
  assert.ok(req.body && typeof req.body === 'object', `request ${index} body not an object`)
  return req.body as Record<string, unknown>
}

function messagesOf(index: number): Array<Record<string, unknown>> {
  const body = bodyOf(index)
  const messages = body.messages
  assert.ok(Array.isArray(messages), `request ${index} messages not an array`)
  return messages as Array<Record<string, unknown>>
}

describe('OpenAICompatDriver tools config', () => {
  test('capabilities.tools true by default', async () => {
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      assert.equal(d.capabilities.tools, true)
    })
  })

  test('capabilities.tools false with tools:false', async () => {
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, tools: false },
      async (d) => {
        assert.equal(d.capabilities.tools, false)
      },
    )
  })

  test('rejects maxToolRounds 0', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxToolRounds: 0 })
  })

  test('rejects maxToolRounds 33', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxToolRounds: 33 })
  })

  test('rejects maxToolRounds 1.5', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', maxToolRounds: 1.5 })
  })

  test('rejects tools "yes"', async () => {
    await rejectsConfig({ baseUrl: baseUrl(), model: 'm1', tools: 'yes' })
  })
})

describe('OpenAICompatDriver tools request body', () => {
  test('tools array in OpenAI function format with tool_choice auto', async () => {
    queue.push({ status: 200, chunks: [delta('ok'), DONE] })
    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      await collect(d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal))
    })
    assert.equal(requests.length, 1)
    const body = bodyOf(0)
    assert.deepEqual(body.tools, [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'lookup tool',
          parameters: { type: 'object', properties: {} },
        },
      },
    ])
    assert.equal(body.tool_choice, 'auto')
  })

  test('tools:false → no tools / tool_choice keys', async () => {
    queue.push({ status: 200, chunks: [delta('ok'), DONE] })
    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, tools: false },
      async (d) => {
        await collect(d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal))
      },
    )
    assert.equal(requests.length, 1)
    const body = bodyOf(0)
    assert.ok(!('tools' in body))
    assert.ok(!('tool_choice' in body))
  })

  test('empty ToolSet → no tools / tool_choice keys', async () => {
    queue.push({ status: 200, chunks: [delta('ok'), DONE] })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      await collect(d.run(makeInput('hi', 'sys'), new AbortController().signal))
    })
    assert.equal(requests.length, 1)
    const body = bodyOf(0)
    assert.ok(!('tools' in body))
    assert.ok(!('tool_choice' in body))
  })
})

describe('OpenAICompatDriver tool loop', () => {
  test('single round: text, tool call, tool result, follow-up, summed usage', async () => {
    queue.push({
      status: 200,
      chunks: [
        delta('Let me check. '),
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{"q":' }),
        toolCallChunk(0, { args: '"lis' }),
        toolCallChunk(0, { args: 'bon"}' }),
        finish('tool_calls'),
        usageChunk(10, 5),
        DONE,
      ],
    })
    queue.push({
      status: 200,
      chunks: [delta('Lisbon it is.'), finish('stop'), usageChunk(20, 4), DONE],
    })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )

      const kinds = events.map((e) => e.type)
      assert.deepEqual(kinds, [
        'text',
        'tool_call',
        'tool_result',
        'text',
        'usage',
        'done',
      ])

      const text = textDeltas(events)
      assert.deepEqual(text, ['Let me check. ', 'Lisbon it is.'])

      const calls = toolCallEvents(events)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.id, 'call_a')
      assert.equal(calls[0]?.name, 'lookup')
      assert.deepEqual(calls[0]?.input, { q: 'lisbon' })

      const results = toolResultEvents(events)
      assert.equal(results.length, 1)
      assert.equal(results[0]?.id, 'call_a')
      assert.equal(results[0]?.output, 'found')
      assert.equal(results[0]?.isError, false)

      const usage = usageEvents(events)
      assert.equal(usage.length, 1)
      assert.equal(usage[0]?.inputTokens, 30)
      assert.equal(usage[0]?.outputTokens, 9)

      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(done[0]?.stopReason, 'end')
      assert.equal(events.at(-1)?.type, 'done')

      assert.equal(tools.calls.length, 1)
      assert.deepEqual(tools.calls[0], { id: 'call_a', name: 'lookup', input: { q: 'lisbon' } })
    })

    assert.equal(requests.length, 2)
    const messages = messagesOf(1)
    assert.deepEqual(messages[0], { role: 'system', content: 'sys' })
    assert.deepEqual(messages[1], { role: 'user', content: 'hi' })
    assert.deepEqual(messages.at(-2), {
      role: 'assistant',
      content: 'Let me check. ',
      tool_calls: [
        {
          id: 'call_a',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"lisbon"}' },
        },
      ],
    })
    assert.deepEqual(messages.at(-1), {
      role: 'tool',
      tool_call_id: 'call_a',
      content: 'found',
    })
  })

  test('two parallel calls interleaved → index order, one assistant message, two tool messages', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{"q":' }),
        toolCallChunk(1, { id: 'call_b', name: 'lookup', args: '{"q":' }),
        toolCallChunk(0, { args: '"a"}' }),
        toolCallChunk(1, { args: '"b"}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('done'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )
      const calls = toolCallEvents(events)
      assert.equal(calls.length, 2)
      assert.equal(calls[0]?.id, 'call_a')
      assert.deepEqual(calls[0]?.input, { q: 'a' })
      assert.equal(calls[1]?.id, 'call_b')
      assert.deepEqual(calls[1]?.input, { q: 'b' })

      const results = toolResultEvents(events)
      assert.equal(results.length, 2)
      assert.equal(results[0]?.id, 'call_a')
      assert.equal(results[1]?.id, 'call_b')
    })

    assert.equal(requests.length, 2)
    const messages = messagesOf(1)
    const assistant = messages.at(-3)
    assert.ok(assistant)
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.content, null)
    const toolCalls = assistant.tool_calls
    assert.ok(Array.isArray(toolCalls))
    assert.equal(toolCalls.length, 2)
    assert.deepEqual(toolCalls[0], {
      id: 'call_a',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"a"}' },
    })
    assert.deepEqual(toolCalls[1], {
      id: 'call_b',
      type: 'function',
      function: { name: 'lookup', arguments: '{"q":"b"}' },
    })
    assert.deepEqual(messages.at(-2), {
      role: 'tool',
      tool_call_id: 'call_a',
      content: 'found',
    })
    assert.deepEqual(messages.at(-1), {
      role: 'tool',
      tool_call_id: 'call_b',
      content: 'found',
    })
  })

  test('no text before tool calls → assistant content null', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('ok'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      await collect(d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal))
    })

    assert.equal(requests.length, 2)
    const messages = messagesOf(1)
    const assistant = messages.at(-2)
    assert.ok(assistant)
    assert.equal(assistant.role, 'assistant')
    assert.equal(assistant.content, null)
  })

  test('missing id from provider → id call_0', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('ok'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )
      const calls = toolCallEvents(events)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.id, 'call_0')
      const results = toolResultEvents(events)
      assert.equal(results[0]?.id, 'call_0')
    })

    assert.equal(requests.length, 2)
    const messages = messagesOf(1)
    const assistant = messages.at(-2)
    assert.ok(assistant)
    const toolCalls = assistant.tool_calls
    assert.ok(Array.isArray(toolCalls))
    assert.equal((toolCalls[0] as Record<string, unknown>).id, 'call_0')
    assert.deepEqual(messages.at(-1), {
      role: 'tool',
      tool_call_id: 'call_0',
      content: 'found',
    })
  })

  test('invalid JSON arguments → no invoke, isError result, follow-up still sent', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{"q": ' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('ok'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )
      assert.equal(tools.calls.length, 0)
      const results = toolResultEvents(events)
      assert.equal(results.length, 1)
      assert.equal(results[0]?.isError, true)
      assert.ok((results[0]?.output ?? '').includes('invalid JSON'), results[0]?.output)
    })

    assert.equal(requests.length, 2)
    const messages = messagesOf(1)
    const toolMessage = messages.at(-1)
    assert.ok(toolMessage)
    assert.equal(toolMessage.role, 'tool')
    assert.equal(toolMessage.tool_call_id, 'call_a')
    assert.ok(
      typeof toolMessage.content === 'string' && toolMessage.content.includes('invalid JSON'),
      String(toolMessage.content),
    )
  })

  test('empty arguments → input {}', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('ok'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )
      const calls = toolCallEvents(events)
      assert.equal(calls.length, 1)
      assert.deepEqual(calls[0]?.input, {})
      assert.equal(tools.calls.length, 1)
      assert.deepEqual(tools.calls[0]?.input, {})
    })
  })

  test('handler returns isError true → tool_result isError true, loop continues', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('after'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'denied', isError: true }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )
      const results = toolResultEvents(events)
      assert.equal(results.length, 1)
      assert.equal(results[0]?.output, 'denied')
      assert.equal(results[0]?.isError, true)
      assert.equal(textDeltas(events).join(''), 'after')
      assert.equal(doneEvents(events)[0]?.stopReason, 'end')
    })
    assert.equal(requests.length, 2)
  })

  test('accumulated tool calls with finish_reason stop still a tool round', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('stop'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('ok'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(
        d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
      )
      assert.equal(toolCallEvents(events).length, 1)
      assert.equal(doneEvents(events)[0]?.stopReason, 'end')
    })
    assert.equal(requests.length, 2)
  })

  test('maxToolRounds 2 with always-tool-call server → 2 requests, limit error', async () => {
    const toolRound = (): Scripted => ({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push(toolRound())
    queue.push(toolRound())
    queue.push(toolRound())

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxToolRounds: 2 },
      async (d) => {
        const events = await collect(
          d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
        )
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        assert.ok((errs[0]?.message ?? '').includes('tool round limit'), errs[0]?.message)
        const done = doneEvents(events)
        assert.equal(done.length, 1)
        assert.equal(done[0]?.stopReason, 'error')
        assert.equal(events.at(-1)?.type, 'done')
      },
    )
    assert.equal(requests.length, 2)
  })

  test('abort inside tool handler → done{cancelled}, no second request', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 200, chunks: [delta('should not happen'), finish('stop'), DONE] })

    const ac = new AbortController()
    const tools = makeTools({
      lookup: () => {
        ac.abort()
        return { output: 'found', isError: false }
      },
    })
    await withDriver({ baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV }, async (d) => {
      const events = await collect(d.run(makeInput('hi', 'sys', tools.set), ac.signal))
      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(done[0]?.stopReason, 'cancelled')
      assert.equal(events.at(-1)?.type, 'done')
      assert.equal(errorEvents(events).length, 0)
    })
    assert.equal(requests.length, 1)
  })

  test('retry works in a follow-up round', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 503, headers: { 'retry-after': '0' }, body: 'busy' })
    queue.push({ status: 200, chunks: [delta('recovered'), finish('stop'), DONE] })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxRetries: 1 },
      async (d) => {
        const events = await collect(
          d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
        )
        assert.equal(textDeltas(events).join(''), 'recovered')
        assert.equal(doneEvents(events)[0]?.stopReason, 'end')
      },
    )
    assert.equal(requests.length, 3)
  })

  test('key redaction applies to errors in follow-up rounds', async () => {
    queue.push({
      status: 200,
      chunks: [
        toolCallChunk(0, { id: 'call_a', name: 'lookup', args: '{}' }),
        finish('tool_calls'),
        DONE,
      ],
    })
    queue.push({ status: 500, body: `server error ${KEY_VALUE}` })

    const tools = makeTools({ lookup: () => ({ output: 'found', isError: false }) })
    await withDriver(
      { baseUrl: baseUrl(), model: 'm1', apiKeyEnv: KEY_ENV, maxRetries: 0 },
      async (d) => {
        const events = await collect(
          d.run(makeInput('hi', 'sys', tools.set), new AbortController().signal),
        )
        const errs = errorEvents(events)
        assert.equal(errs.length, 1)
        const msg = errs[0]?.message ?? ''
        assert.ok(msg.includes('[redacted]'), msg)
        assert.ok(!msg.includes(KEY_VALUE), msg)
        assert.equal(doneEvents(events)[0]?.stopReason, 'error')
      },
    )
    assert.equal(requests.length, 2)
  })
})
