import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { Service, type Context } from 'cordis'
import type { Driver, DriverCapabilities, DriverEvent, TurnInput } from '../contracts/driver.ts'

export interface StubConfig {
  model?: string
  script?: string[]
  template?: string
  delayMs?: number
  listen?: boolean
  heartbeatMs?: number
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

function splitDeltas(reply: string): string[] {
  if (reply.length === 0) return []
  const matches = reply.match(/\s*\S+/g) ?? []
  if (matches.length === 0) return [reply]
  const joined = matches.join('')
  if (joined.length < reply.length) {
    const trailing = reply.slice(joined.length)
    const last = matches[matches.length - 1]
    if (last !== undefined) matches[matches.length - 1] = last + trailing
  }
  return matches
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export class StubDriver extends Service implements Driver {
  readonly kind = 'stub'
  readonly model: string
  readonly capabilities: DriverCapabilities = {
    tools: false,
    agentic: false,
    statefulSession: false,
  }

  private _ticks = 0
  private _runs = 0
  private _script: string[]
  private _template: string
  private _delayMs: number
  private _listen: boolean
  private _portPromise: Promise<number> | null = null

  constructor(ctx: Context, config: StubConfig = {}) {
    super(ctx, 'driver')

    const model = config.model ?? 'stub-1'
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('driver-stub: model must be a non-empty string')
    }

    const script = config.script ?? []
    if (!Array.isArray(script) || script.some((s) => typeof s !== 'string')) {
      throw new TypeError('driver-stub: script must be an array of strings')
    }

    const template = config.template ?? 'echo: {prompt}'
    if (typeof template !== 'string') {
      throw new TypeError('driver-stub: template must be a string')
    }

    const delayMs = config.delayMs ?? 0
    if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('driver-stub: delayMs must be a finite number >= 0')
    }

    const listen = config.listen ?? false
    if (typeof listen !== 'boolean') {
      throw new TypeError('driver-stub: listen must be a boolean')
    }

    const heartbeatMs = config.heartbeatMs ?? 0
    if (typeof heartbeatMs !== 'number' || !Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
      throw new TypeError('driver-stub: heartbeatMs must be a finite number >= 0')
    }

    this.model = model
    this._script = [...script]
    this._template = template
    this._delayMs = delayMs
    this._listen = listen

    if (heartbeatMs > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          this._ticks++
        }, heartbeatMs)
        return () => clearInterval(timer)
      })
    }

    if (listen) {
      ctx.effect(() => {
        const sockets = new Set<net.Socket>()
        const server = net.createServer((socket) => {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
          socket.end()
        })
        const promise = new Promise<number>((resolve, reject) => {
          server.once('listening', () => {
            resolve((server.address() as AddressInfo).port)
          })
          server.once('error', reject)
          server.listen(0, '127.0.0.1')
        })
        promise.catch(() => {})
        this._portPromise = promise
        return () => {
          this._portPromise = null
          for (const socket of sockets) socket.destroy()
          sockets.clear()
          server.close()
        }
      })
    }
  }

  get ticks(): number {
    return this._ticks
  }

  get runs(): number {
    return this._runs
  }

  port(): Promise<number> {
    if (!this._listen || this._portPromise === null) {
      return Promise.reject(new Error('driver-stub: not listening'))
    }
    return this._portPromise
  }

  async *run(input: TurnInput, signal: AbortSignal): AsyncIterable<DriverEvent> {
    if (signal.aborted) {
      this._runs++
      yield { type: 'done', stopReason: 'cancelled' }
      return
    }

    let reply: string
    if (this._script.length > 0) {
      const index = this._runs % this._script.length
      reply = this._script[index] ?? ''
    } else {
      reply = this._template
        .replaceAll('{prompt}', input.prompt)
        .replaceAll('{model}', this.model)
    }

    const deltas = splitDeltas(reply)

    for (const delta of deltas) {
      if (this._delayMs > 0) {
        await abortableSleep(this._delayMs, signal)
      }
      if (signal.aborted) {
        this._runs++
        yield { type: 'done', stopReason: 'cancelled' }
        return
      }
      yield { type: 'text', delta }
    }

    if (signal.aborted) {
      this._runs++
      yield { type: 'done', stopReason: 'cancelled' }
      return
    }

    yield {
      type: 'usage',
      inputTokens: words(input.system) + words(input.prompt),
      outputTokens: words(reply),
    }
    this._runs++
    yield { type: 'done', stopReason: 'end' }
  }
}

export default StubDriver
