import net from 'node:net'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { WebSocket } from 'ws'
import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import { startServer, type RunningServer } from '../../src/server/server.ts'
import type {} from '../../src/contracts/index.ts'

interface CallOptions {
  headers?: Record<string, string>
  body?: string
}

interface CallResult {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
}

function call(url: string, method: string, pathname: string, options: CallOptions = {}): Promise<CallResult> {
  const target = new URL(pathname, url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra }
}

interface WsMessage {
  type?: string
  [key: string]: unknown
}

/** Collects frames from a WebSocket; `waitFor` resolves when a frame matching the predicate arrives. */
class WsClient {
  readonly socket: WebSocket
  readonly frames: WsMessage[] = []
  readonly closeCode: Promise<number>
  private readonly waiters: { predicate: (m: WsMessage) => boolean; resolve: (m: WsMessage) => void }[] = []

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers })
    // A refused upgrade surfaces as an 'error' then a 'close' (1006); without a listener it would crash the test.
    this.socket.on('error', () => {})
    this.socket.on('message', (data: Buffer) => {
      const parsed = JSON.parse(data.toString('utf8')) as WsMessage
      this.frames.push(parsed)
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i]
        if (waiter && waiter.predicate(parsed)) {
          this.waiters.splice(i, 1)
          waiter.resolve(parsed)
        }
      }
    })
    this.closeCode = new Promise((resolve) => {
      this.socket.on('close', (code: number) => resolve(code))
    })
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
  }

  waitFor(predicate: (m: WsMessage) => boolean, timeoutMs = 3000): Promise<WsMessage> {
    const existing = this.frames.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  send(value: unknown): void {
    this.socket.send(JSON.stringify(value))
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const tmp = mkdtempSync(path.join(tmpdir(), 'whales-sec-'))
const staticDir = path.join(tmp, 'dist')
const outsideDir = path.join(tmp, 'outside')
mkdirSync(staticDir, { recursive: true })
mkdirSync(outsideDir, { recursive: true })
writeFileSync(path.join(staticDir, 'index.html'), '<h1>ui</h1>')
writeFileSync(path.join(staticDir, 'app.js'), 'export const x = 1\n')
writeFileSync(path.join(outsideDir, 'secret.txt'), 'TOP-SECRET-CONTENT')
let symlinkCreated = false
try {
  symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(staticDir, 'link'))
  symlinkCreated = true
} catch {
  symlinkCreated = false
}

let app: Awaited<ReturnType<typeof createApp>>
let srv: RunningServer

before(async () => {
  app = await createApp({ config: defaultConfig({ env: {}, home: tmp, cwd: tmp }), storePath: ':memory:' })
  srv = await startServer(app, { host: '127.0.0.1', port: 0, env: {}, staticDir })
})

after(async () => {
  await srv.close()
  await app.stop()
  rmSync(tmp, { recursive: true, force: true })
})

describe('token authentication', () => {
  it('rejects a request without Authorization', async () => {
    const res = await call(srv.url, 'GET', '/api/health', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.equal(res.status, 401)
    assert.equal(res.headers['www-authenticate'], 'Bearer')
    assert.ok(!res.text.includes(srv.token))
  })

  it('rejects a wrong token', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders('wrong-token-value-that-is-long-enough', { host: `127.0.0.1:${srv.port}` }),
    })
    assert.equal(res.status, 401)
    assert.ok(!res.text.includes(srv.token))
  })

  it('rejects a token with one character changed', async () => {
    const first = srv.token[0] ?? 'a'
    const mutated = (first === 'a' ? 'b' : 'a') + srv.token.slice(1)
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(mutated, { host: `127.0.0.1:${srv.port}` }),
    })
    assert.equal(res.status, 401)
  })

  it('rejects a Basic scheme carrying the token', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: { authorization: `Basic ${srv.token}`, host: `127.0.0.1:${srv.port}` },
    })
    assert.equal(res.status, 401)
  })

  it('accepts the correct token', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}` }),
    })
    assert.equal(res.status, 200)
    assert.equal((JSON.parse(res.text) as { ok?: unknown }).ok, true)
  })
})

describe('token generation', () => {
  it('generates a token of at least 24 characters', () => {
    assert.equal(srv.tokenSource, 'generated')
    assert.ok(srv.token.length >= 24)
  })

  it('gives two servers different tokens', async () => {
    const other = await startServer(app, { host: '127.0.0.1', port: 0, env: {} })
    try {
      assert.notEqual(other.token, srv.token)
    } finally {
      await other.close()
    }
  })

  it('uses the env token when set', async () => {
    const envToken = 'x'.repeat(30)
    const other = await startServer(app, { host: '127.0.0.1', port: 0, env: { WHALES_API_TOKEN: envToken } })
    try {
      assert.equal(other.token, envToken)
      assert.equal(other.tokenSource, 'env')
    } finally {
      await other.close()
    }
  })

  it('rejects a too-short env token', async () => {
    await assert.rejects(
      Promise.resolve(startServer(app, { host: '127.0.0.1', port: 0, env: { WHALES_API_TOKEN: 'x'.repeat(10) } })),
    )
  })

  it('puts the token in the URL fragment, not the query', () => {
    assert.ok(srv.uiUrl.includes('#token='))
    assert.ok(!srv.uiUrl.includes('?token='))
  })
})

describe('host header (DNS rebinding)', () => {
  it('rejects a foreign Host with a valid token', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `evil.example:${srv.port}` }),
    })
    assert.equal(res.status, 421)
  })

  it('rejects a loopback Host with the wrong port', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port + 1}` }),
    })
    assert.equal(res.status, 421)
  })

  it('rejects a missing Host', async () => {
    // node:http always fills in Host, so speak raw HTTP. HTTP/1.1 without Host is refused by Node itself (400);
    // HTTP/1.0 without Host and an empty Host reach the guard (421). Either way: never 200.
    const raw = (text: string) =>
      new Promise<string>((resolve) => {
        const socket = net.connect(srv.port, '127.0.0.1', () => socket.end(text))
        let out = ''
        socket.on('data', (chunk) => (out += String(chunk)))
        socket.on('close', () => resolve(out.split('\r\n')[0] ?? ''))
      })
    assert.match(await raw(`GET /api/health HTTP/1.1\r\nAuthorization: Bearer ${srv.token}\r\nConnection: close\r\n\r\n`), / 400 /)
    assert.match(await raw(`GET /api/health HTTP/1.0\r\nAuthorization: Bearer ${srv.token}\r\n\r\n`), / 421 /)
    assert.match(await raw(`GET /api/health HTTP/1.1\r\nHost: \r\nAuthorization: Bearer ${srv.token}\r\nConnection: close\r\n\r\n`), / 421 /)
  })

  it('accepts localhost and [::1] hosts', async () => {
    const localhost = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `localhost:${srv.port}` }),
    })
    assert.equal(localhost.status, 200)
    const ipv6 = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `[::1]:${srv.port}` }),
    })
    assert.equal(ipv6.status, 200)
  })

  it('rejects malformed Host headers', async () => {
    const at = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}@evil` }),
    })
    // Node's parser may reject these itself (400) before the guard (421); both are refusals.
    assert.ok(at.status === 421 || at.status === 400, String(at.status))
    const spaced = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port} evil` }),
    })
    assert.ok(spaced.status === 421 || spaced.status === 400, String(spaced.status))
  })
})

describe('origin checks', () => {
  it('rejects a cross-origin request', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}`, origin: 'https://evil.example' }),
    })
    assert.equal(res.status, 403)
  })

  it('rejects a null origin', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}`, origin: 'null' }),
    })
    assert.equal(res.status, 403)
  })

  it('accepts the server origin', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}` }),
    })
    assert.equal(res.status, 200)
  })

  it('accepts a request with no origin (CLI)', async () => {
    const res = await call(srv.url, 'GET', '/api/health', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}` }),
    })
    assert.equal(res.status, 200)
  })
})

describe('body limit', () => {
  it('rejects a 2 MiB body with 413', async () => {
    const body = JSON.stringify({ pad: 'a'.repeat(2 * 1024 * 1024) })
    // The server answers 413 and closes the connection; a client still uploading may see EPIPE/ECONNRESET instead.
    try {
      const res = await call(srv.url, 'POST', '/api/rules', {
        headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json' }),
        body,
      })
      assert.equal(res.status, 413)
    } catch (err) {
      const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
      assert.ok(code === 'EPIPE' || code === 'ECONNRESET', String(err))
    }
    // Nothing from the oversized body was stored, and the server still answers normally.
    const rules = await call(srv.url, 'GET', '/api/rules', { headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}` }) })
    assert.equal(rules.status, 200)
    assert.equal(rules.text, '[]')
  })
})

describe('error handling', () => {
  it('returns 400 for invalid JSON without stack traces', async () => {
    const res = await call(srv.url, 'POST', '/api/agents', {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json', 'content-length': '10' }),
      body: '{ not json',
    })
    assert.equal(res.status, 400)
    assert.ok(!res.text.includes('at '))
  })
})

describe('websocket /api/events', () => {
  const wsUrl = (): string => `ws://127.0.0.1:${srv.port}/api/events`

  it('rejects a cross-origin upgrade', async () => {
    const client = new WsClient(wsUrl(), { host: `127.0.0.1:${srv.port}`, origin: 'https://evil.example' })
    const code = await client.closeCode
    assert.notEqual(code, 1000)
    client.close()
  })

  it('rejects a wrong Host upgrade', async () => {
    const client = new WsClient(wsUrl(), { host: `evil.example:${srv.port}`, origin: `http://127.0.0.1:${srv.port}` })
    const code = await client.closeCode
    assert.notEqual(code, 1000)
    client.close()
  })

  it('closes with 4401 when the first message carries a wrong token', async () => {
    const client = new WsClient(wsUrl(), { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}` })
    await client.open()
    client.send({ type: 'auth', token: 'wrong-token-value-that-is-long-enough' })
    const code = await client.closeCode
    assert.equal(code, 4401)
  })

  it('sends no frames before authentication', async () => {
    const client = new WsClient(wsUrl(), { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}` })
    await client.open()
    await delay(200)
    assert.equal(client.frames.length, 0)
    assert.equal(client.socket.readyState, WebSocket.OPEN)
    client.send({ type: 'auth', token: srv.token })
    const ready = await client.waitFor((m) => m.type === 'ready')
    assert.equal(ready.type, 'ready')
    client.close()
  })

  it('emits agent-spawned to an authenticated client', async () => {
    const client = new WsClient(wsUrl(), { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}` })
    await client.open()
    client.send({ type: 'auth', token: srv.token })
    await client.waitFor((m) => m.type === 'ready')
    const spawned = client.waitFor((m) => m.type === 'agent-spawned')
    await app.ctx.agents.spawn(
      {
        id: 'sec-ws-agent',
        name: 'sec-ws-agent',
        seniority: 1,
        driver: { name: 'driver-stub', config: { template: '{prompt}' } },
        plugins: [],
      },
      { persist: false },
    )
    const frame = await spawned
    assert.equal(frame.type, 'agent-spawned')
    client.close()
  })

  it('sends no event frames to an unauthenticated client', async () => {
    const client = new WsClient(wsUrl(), { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}` })
    await client.open()
    await app.ctx.agents.spawn(
      {
        id: 'sec-ws-agent-2',
        name: 'sec-ws-agent-2',
        seniority: 1,
        driver: { name: 'driver-stub', config: { template: '{prompt}' } },
        plugins: [],
      },
      { persist: false },
    )
    await delay(200)
    assert.equal(client.frames.length, 0)
    client.close()
  })
})

describe('approval round-trip', () => {
  it('delivers approval-requested and approval-resolved over the socket', async () => {
    const client = new WsClient(`ws://127.0.0.1:${srv.port}/api/events`, {
      host: `127.0.0.1:${srv.port}`,
      origin: `http://127.0.0.1:${srv.port}`,
    })
    await client.open()
    client.send({ type: 'auth', token: srv.token })
    await client.waitFor((m) => m.type === 'ready')

    const approvals = app.ctx.get('approvals')
    assert.ok(approvals)
    const requested = client.waitFor((m) => m.type === 'approval-requested')
    const pending = approvals.authorize(
      { kind: 'shell', target: 'ls', agentId: 'a', summary: 'x' },
      { mode: 'ask' },
    )
    const frame = await requested
    // Frames are { type, data }; the approval request is the data.
    const data = frame.data
    const id = typeof data === 'object' && data !== null && 'id' in data ? data.id : undefined
    assert.equal(typeof id, 'string')

    const resolved = client.waitFor((m) => m.type === 'approval-resolved')
    const res = await call(srv.url, 'POST', `/api/approvals/${String(id)}`, {
      headers: authHeaders(srv.token, { host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json' }),
      body: JSON.stringify({ decision: 'deny' }),
    })
    assert.equal(res.status, 200)
    const outcome = await pending
    assert.equal(outcome.allowed, false)
    await resolved
    client.close()
  })
})

describe('static serving', () => {
  it('serves index.html with security headers', async () => {
    const res = await call(srv.url, 'GET', '/', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.equal(res.status, 200)
    assert.ok(res.text.includes('<h1>ui</h1>'))
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['x-frame-options'], 'DENY')
    assert.ok(String(res.headers['content-security-policy']).includes("frame-ancestors 'none'"))
  })

  it('serves app.js with a JS content type', async () => {
    const res = await call(srv.url, 'GET', '/app.js', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.equal(res.status, 200)
    assert.ok(String(res.headers['content-type']).includes('javascript'))
  })

  it('falls back to index.html for deep links', async () => {
    const res = await call(srv.url, 'GET', '/deep/link', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.equal(res.status, 200)
    assert.ok(res.text.includes('<h1>ui</h1>'))
  })

  it('never serves files outside the static root', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt']) {
      const res = await call(srv.url, 'GET', p, { headers: { host: `127.0.0.1:${srv.port}` } })
      assert.ok(!res.text.includes('TOP-SECRET-CONTENT'))
    }
  })

  it('never follows a symlink out of the static root', { skip: !symlinkCreated }, async () => {
    const res = await call(srv.url, 'GET', '/link/secret.txt', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.ok(!res.text.includes('TOP-SECRET-CONTENT'))
  })

  it('serves static routes without a token but keeps /api guarded', async () => {
    const staticRes = await call(srv.url, 'GET', '/', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.equal(staticRes.status, 200)
    const apiRes = await call(srv.url, 'GET', '/api/health', { headers: { host: `127.0.0.1:${srv.port}` } })
    assert.equal(apiRes.status, 401)
  })
})

describe('binding beyond loopback', () => {
  it('rejects 0.0.0.0 with a generated token', async () => {
    await assert.rejects(Promise.resolve(startServer(app, { host: '0.0.0.0', port: 0, env: {} })))
  })
})
