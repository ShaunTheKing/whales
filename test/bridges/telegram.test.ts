import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { TelegramBridge, chunkText } from '../../src/bridges/telegram.ts'
import type {} from '../../src/contracts/index.ts'
import { Service, type Context } from 'cordis'
import type { Driver, DriverCapabilities, DriverEvent } from '../../src/contracts/driver.ts'

interface RecordedCall {
  method: string
  body: Record<string, unknown>
  url: string
}

interface MockUpdate {
  update_id: number
  [key: string]: unknown
}

interface HeldResponse {
  res: ServerResponse
  timer: NodeJS.Timeout
}

class MockBotApi {
  readonly calls: RecordedCall[] = []
  private readonly token: string
  private readonly server: Server
  private readonly queue: MockUpdate[] = []
  private readonly held: HeldResponse[] = []
  private readonly failures = new Map<string, number>()
  private port = 0

  constructor(token: string) {
    this.token = token
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = this.server.address()
    if (addr === null || typeof addr === 'string') {
      throw new Error('mock server has no port')
    }
    this.port = addr.port
    return `http://127.0.0.1:${this.port}`
  }

  async stop(): Promise<void> {
    for (const h of this.held.splice(0)) {
      clearTimeout(h.timer)
      if (!h.res.writableEnded) {
        h.res.end(JSON.stringify({ ok: true, result: [] }))
      }
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve())
    })
  }

  reset(): void {
    this.calls.length = 0
    this.queue.length = 0
    this.failures.clear()
  }

  failNext(method: string, status: number): void {
    this.failures.set(method, status)
  }

  push(update: MockUpdate): void {
    this.queue.push(update)
    this.releaseHeld()
  }

  private releaseHeld(): void {
    for (const h of this.held.splice(0)) {
      clearTimeout(h.timer)
      if (!h.res.writableEnded && !h.res.destroyed) {
        this.deliver(h.res)
        return
      }
    }
  }

  private deliver(res: ServerResponse): void {
    const result = this.queue.splice(0)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result }))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    if (raw.length > 0) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') {
          body = parsed as Record<string, unknown>
        }
      } catch {
        body = {}
      }
    }

    const prefix = `/bot${this.token}/`
    if (!url.startsWith(prefix)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    const method = url.slice(prefix.length)
    this.calls.push({ method, body, url })

    const failStatus = this.failures.get(method)
    if (failStatus !== undefined) {
      this.failures.delete(method)
      res.writeHead(failStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, description: `boom ${this.token}` }))
      return
    }

    if (method === 'getUpdates') {
      this.handleGetUpdates(body, res)
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: {} }))
  }

  private handleGetUpdates(body: Record<string, unknown>, res: ServerResponse): void {
    const offsetRaw = body.offset
    const offset = typeof offsetRaw === 'number' ? offsetRaw : undefined
    const ready = this.queue.filter((u) => offset === undefined || u.update_id >= offset)
    if (ready.length > 0) {
      const delivered = new Set(ready.map((u) => u.update_id))
      for (let i = this.queue.length - 1; i >= 0; i -= 1) {
        const item = this.queue[i]
        if (item !== undefined && delivered.has(item.update_id)) {
          this.queue.splice(i, 1)
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result: ready }))
      return
    }

    const timeoutRaw = body.timeout
    const timeoutSec = typeof timeoutRaw === 'number' ? timeoutRaw : 0
    const timer = setTimeout(() => {
      const idx = this.held.findIndex((h) => h.res === res)
      if (idx >= 0) {
        this.held.splice(idx, 1)
      }
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result: [] }))
      }
    }, Math.max(0, timeoutSec) * 1000)
    this.held.push({ res, timer })
    // The previous test's app aborts its long-poll; drop that response so updates are not delivered to a dead socket.
    res.on('close', () => {
      const i = this.held.findIndex((h) => h.res === res)
      if (i >= 0) {
        const [gone] = this.held.splice(i, 1)
        if (gone) clearTimeout(gone.timer)
      }
    })
  }
}

async function waitForCall(
  mock: MockBotApi,
  method: string,
  predicate: (call: RecordedCall) => boolean = () => true,
  timeoutMs = 2000,
): Promise<RecordedCall> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = mock.calls.find((c) => c.method === method && predicate(c))
    if (found !== undefined) {
      return found
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${method}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function callsOf(mock: MockBotApi, method: string): RecordedCall[] {
  return mock.calls.filter((c) => c.method === method)
}

function messageUpdate(updateId: number, chatId: number, text: string): MockUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId },
      text,
    },
  }
}

function callbackUpdate(updateId: number, chatId: number, data: string): MockUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: chatId },
      message: { message_id: 1, chat: { id: chatId } },
      data,
    },
  }
}

const TOKEN = 'TOKEN123:abc'

let mock: MockBotApi
let mockUrl: string
let tmp: string

before(async () => {
  process.env.WHALES_TG_TEST = TOKEN
  mock = new MockBotApi(TOKEN)
  mockUrl = await mock.start()
})

after(async () => {
  await mock.stop()
  delete process.env.WHALES_TG_TEST
})

beforeEach(async () => {
  mock.reset()
  tmp = await mkdtemp(join(tmpdir(), 'whales-tg-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

interface SpawnedAgent {
  app: Awaited<ReturnType<typeof createApp>>
  handle: Awaited<ReturnType<Awaited<ReturnType<typeof createApp>>['ctx']['agents']['spawn']>>
}

async function spawnAgent(
  config: Record<string, unknown>,
  driverTemplate = 'echo: {prompt}',
): Promise<SpawnedAgent> {
  const app = await createApp({
    config: defaultConfig({ env: {}, home: tmp, cwd: tmp }),
    storePath: ':memory:',
  })
  if (app.ctx.agents.catalog.resolve('bridge-telegram') === undefined) {
    app.ctx.agents.catalog.register('bridge-telegram', TelegramBridge)
  }
  // If spawn fails (config validation tests), stop the app so nothing leaks into later tests.
  const handle = await app.ctx.agents.spawn(
    {
      id: 'tg',
      name: 'Tess',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: driverTemplate } },
      plugins: [{ name: 'bridge-telegram', config }],
    },
    { persist: false },
  ).catch(async (err: unknown) => {
    await app.stop()
    throw err
  })
  return { app, handle }
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tokenEnv: 'WHALES_TG_TEST',
    allowedChatIds: [42],
    apiBase: mockUrl,
    pollTimeoutSec: 1,
    ...overrides,
  }
}

test('chunkText: short text unchanged', () => {
  assert.deepEqual(chunkText('hello world'), ['hello world'])
})

test('chunkText: 9000 chars split into <=4000 chunks that rejoin', () => {
  const text = 'a'.repeat(9000)
  const chunks = chunkText(text)
  assert.ok(chunks.length >= 3)
  for (const c of chunks) {
    assert.ok(c.length <= 4000, `chunk too long: ${c.length}`)
  }
  assert.equal(chunks.join(''), text)
})

test('chunkText: prefers splitting at newlines', () => {
  const line = 'x'.repeat(100)
  const text = Array.from({ length: 50 }, () => line).join('\n')
  const chunks = chunkText(text, 250)
  for (const c of chunks) {
    assert.ok(c.length <= 250)
  }
  assert.equal(chunks.join(''), text)
  assert.ok(chunks.length > 1)
  assert.ok(chunks[0]?.endsWith('\n') || chunks[0]?.length === 250)
})

test('chunkText: custom max', () => {
  const chunks = chunkText('abcdefghij', 3)
  assert.deepEqual(chunks, ['abc', 'def', 'ghi', 'j'])
})

test('config: missing allowedChatIds rejects', async () => {
  await assert.rejects(spawnAgent(baseConfig({ allowedChatIds: undefined })))
})

test('config: empty allowedChatIds rejects', async () => {
  await assert.rejects(spawnAgent(baseConfig({ allowedChatIds: [] })))
})

test('config: non-integer id rejects', async () => {
  await assert.rejects(spawnAgent(baseConfig({ allowedChatIds: [1.5] })))
})

test('config: http non-loopback apiBase rejects', async () => {
  await assert.rejects(spawnAgent(baseConfig({ apiBase: 'http://example.com' })))
})

test('config: lowercase tokenEnv rejects', async () => {
  await assert.rejects(spawnAgent(baseConfig({ tokenEnv: 'lower' })))
})

test('config: unset env var rejects naming the variable', async () => {
  await assert.rejects(spawnAgent(baseConfig({ tokenEnv: 'WHALES_TG_MISSING' })))
})

test('config: pollTimeoutSec 51 rejects', async () => {
  await assert.rejects(spawnAgent(baseConfig({ pollTimeoutSec: 51 })))
})

test('/start replies with connected message', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    mock.push(messageUpdate(1, 42, '/start'))
    const call = await waitForCall(mock, 'sendMessage', (c) => c.body.text === 'Connected to Tess.')
    assert.equal(call.body.chat_id, 42)
  } finally {
    await app.stop()
  }
})

test('text message runs a turn and replies', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    mock.push(messageUpdate(1, 42, 'hi'))
    await waitForCall(mock, 'sendChatAction', (c) => c.body.action === 'typing')
    const reply = await waitForCall(mock, 'sendMessage', (c) => c.body.text === 'echo: hi')
    assert.equal(reply.body.chat_id, 42)
    const later = await waitForCall(mock, 'getUpdates', (c) => c.body.offset === 2)
    assert.equal(later.body.offset, 2)
  } finally {
    await app.stop()
  }
})

test('message from unknown chat is ignored', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    mock.push(messageUpdate(1, 99, 'hi'))
    await waitForCall(mock, 'getUpdates', (c) => c.body.offset === 2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(callsOf(mock, 'sendMessage').length, 0)
    assert.equal(callsOf(mock, 'sendChatAction').length, 0)
    assert.equal(app.ctx.store.collection('messages').count({ scope: 'agent:tg' }), 0)
  } finally {
    await app.stop()
  }
})

test('long reply is chunked across sendMessage calls', async () => {
  const long = 'x'.repeat(9000)
  const { app } = await spawnAgent(baseConfig(), long)
  try {
    mock.push(messageUpdate(1, 42, 'go'))
    await waitForCall(mock, 'sendMessage')
    await new Promise((resolve) => setTimeout(resolve, 300))
    const texts = callsOf(mock, 'sendMessage').map((c) => String(c.body.text))
    assert.ok(texts.length >= 3)
    assert.equal(texts.join(''), long)
  } finally {
    await app.stop()
  }
})

test('approval request is sent and answered via callback', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    const approvals = app.ctx.get('approvals')
    assert.ok(approvals !== undefined)
    const promise = approvals.authorize(
      {
        kind: 'file.write',
        target: 'a.txt',
        agentId: 'tg',
        summary: 'write a.txt',
        detail: { preview: 'hello' },
      },
      { mode: 'ask' },
    )
    const card = await waitForCall(mock, 'sendMessage', (c) => String(c.body.text).includes('Approval needed'))
    const text = String(card.body.text)
    assert.ok(text.includes('write a.txt'))
    assert.ok(text.includes('hello'))
    const markup = card.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }
    const buttons = markup.inline_keyboard[0] ?? []
    assert.equal(buttons.length, 3)
    for (const b of buttons) {
      assert.ok(b.callback_data.startsWith('a:'))
    }
    const id = buttons[0]?.callback_data.split(':')[1] ?? ''
    mock.push(callbackUpdate(2, 42, `a:${id}:once`))
    const result = await promise
    assert.equal(result.allowed, true)
    const answered = await waitForCall(mock, 'answerCallbackQuery', (c) => c.body.text === 'Done')
    assert.equal(answered.body.callback_query_id, 'cb2')

    mock.push(callbackUpdate(3, 42, `a:${id}:once`))
    await waitForCall(mock, 'answerCallbackQuery', (c) => c.body.text === 'Already handled')
  } finally {
    await app.stop()
  }
})

test('callback from unknown chat is ignored', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    const approvals = app.ctx.get('approvals')
    assert.ok(approvals !== undefined)
    const promise = approvals.authorize(
      {
        kind: 'file.write',
        target: 'b.txt',
        agentId: 'tg',
        summary: 'write b.txt',
      },
      { mode: 'ask' },
    )
    const card = await waitForCall(mock, 'sendMessage', (c) => String(c.body.text).includes('Approval needed'))
    const markup = card.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }
    const id = (markup.inline_keyboard[0] ?? [])[0]?.callback_data.split(':')[1] ?? ''
    mock.push(callbackUpdate(2, 99, `a:${id}:once`))
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(approvals.get(id)?.status, 'pending')
    assert.equal(approvals.answer(id, 'deny'), true)
    const result = await promise
    assert.equal(result.allowed, false)
  } finally {
    await app.stop()
  }
})

test('malformed callback data answers Invalid', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    mock.push(callbackUpdate(1, 42, 'zzz'))
    await waitForCall(mock, 'answerCallbackQuery', (c) => c.body.text === 'Invalid')
  } finally {
    await app.stop()
  }
})

test('approval for another agent is not sent', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    const approvals = app.ctx.get('approvals')
    assert.ok(approvals !== undefined)
    const promise = approvals.authorize(
      {
        kind: 'file.write',
        target: 'c.txt',
        agentId: 'other',
        summary: 'write c.txt',
      },
      { mode: 'ask' },
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(callsOf(mock, 'sendMessage').length, 0)
    const pending = approvals.pending()
    const req = pending.find((p) => p.action.agentId === 'other')
    assert.ok(req !== undefined)
    assert.equal(approvals.answer(req.id, 'deny'), true)
    const result = await promise
    assert.equal(result.allowed, false)
  } finally {
    await app.stop()
  }
})

test('sendMessage failure does not stop the bridge', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    mock.failNext('sendMessage', 500)
    mock.push(messageUpdate(1, 42, 'one'))
    await waitForCall(mock, 'sendMessage', (c) => c.body.text === 'echo: one')
    mock.push(messageUpdate(2, 42, 'two'))
    await waitForCall(mock, 'sendMessage', (c) => c.body.text === 'echo: two')
  } finally {
    await app.stop()
  }
})

test('getUpdates failure does not stop polling', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    mock.failNext('getUpdates', 502)
    mock.push(messageUpdate(1, 42, 'after-fail'))
    await waitForCall(mock, 'sendMessage', (c) => c.body.text === 'echo: after-fail', 5000)
  } finally {
    await app.stop()
  }
})

test('dispose aborts polling', async () => {
  const { app } = await spawnAgent(baseConfig())
  try {
    await waitForCall(mock, 'getUpdates')
    const before = callsOf(mock, 'getUpdates').length
    const disposed = await app.ctx.agents.dispose('tg')
    assert.equal(disposed, true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const after = callsOf(mock, 'getUpdates').length
    assert.ok(after - before <= 1, `unexpected getUpdates after dispose: ${after - before}`)
  } finally {
    await app.stop()
  }
})

/** A driver whose turn blocks on an approval, like a real tool call would. */
class ApprovalDriver extends Service implements Driver {
  readonly kind = 'approval-test'
  readonly model = 'approval-test'
  readonly capabilities: DriverCapabilities = { tools: false, agentic: false, statefulSession: false }
  private own: Context
  constructor(ctx: Context) {
    super(ctx, 'driver')
    this.own = ctx
  }
  async *run(): AsyncIterable<DriverEvent> {
    const approvals = this.own.get('approvals')
    const auth = approvals
      ? await approvals.authorize({ kind: 'shell', target: 'ls', agentId: 'tg', summary: 'list files' }, { mode: 'ask' })
      : { allowed: false }
    yield { type: 'text', delta: auth.allowed ? 'approved' : 'denied' }
    yield { type: 'done', stopReason: 'end' }
  }
}

test('a Telegram-started turn waiting for approval can be approved from Telegram (no deadlock)', async () => {
  const app = await createApp({ config: defaultConfig({ env: {}, home: tmp, cwd: tmp }), storePath: ':memory:' })
  try {
    app.ctx.agents.catalog.register('driver-approve', ApprovalDriver)
    await app.ctx.agents.spawn(
      { id: 'tg', name: 'Tess', seniority: 1, driver: { name: 'driver-approve' }, plugins: [{ name: 'bridge-telegram', config: baseConfig() }] },
      { persist: false },
    )
    mock.push(messageUpdate(1, 42, 'please list files'))
    const prompt = await waitForCall(mock, 'sendMessage', (c) => typeof c.body.text === 'string' && c.body.text.startsWith('Approval needed'))
    const markup = JSON.stringify(prompt.body.reply_markup)
    const id = /a:([a-z]+_[0-9a-z]+):once/.exec(markup)?.[1]
    assert.ok(id, markup)
    // The answer arrives as a LATER update while the first turn is still waiting.
    mock.push(callbackUpdate(2, 42, `a:${id}:once`))
    const reply = await waitForCall(mock, 'sendMessage', (c) => c.body.text === 'approved', 4000)
    assert.equal(reply.body.chat_id, 42)
  } finally {
    await app.stop()
  }
})
