import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Server as HttpServer } from 'node:http'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { serve } from '@hono/node-server'
import type { App } from '../core/app.ts'
import { createApi } from './api.ts'
import { attachEventSocket } from './events.ts'
import { allowedHosts, apiGuard, createSecurity, resolveToken } from './security.ts'

export interface ServerOptions {
  /** Default: config.server.host / config.server.port. Port 0 picks a free port (tests). */
  host?: string
  port?: number
  env?: Record<string, string | undefined>
  /** Built web UI (web/dist). Omitted or missing → API only. */
  staticDir?: string
  devOrigins?: string[]
}

export interface RunningServer {
  url: string
  port: number
  /** Open this in a browser: the token travels in the URL fragment, which browsers never send to servers. */
  uiUrl: string
  token: string
  tokenSource: 'env' | 'generated'
  close(): Promise<void>
}

const MAX_BODY = 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
}

/** Serves files from `root` only (real paths, no symlink escape); unknown paths fall back to index.html (SPA). */
async function staticFile(root: string, urlPath: string): Promise<{ body: Buffer; type: string } | undefined> {
  const realRoot = await realpath(root)
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const candidate = path.resolve(realRoot, `.${path.posix.normalize(decoded)}`)
  const pick = async (file: string) => {
    try {
      const real = await realpath(file)
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined
      if (!(await stat(real)).isFile()) return undefined
      return { body: await readFile(real), type: TYPES[path.extname(real)] ?? 'application/octet-stream' }
    } catch {
      return undefined
    }
  }
  return (await pick(candidate)) ?? (await pick(path.join(realRoot, 'index.html')))
}

export async function startServer(app: App, options: ServerOptions = {}): Promise<RunningServer> {
  const config = app.ctx.config
  const host = options.host ?? config.server.host
  const env = options.env ?? process.env
  if (!LOOPBACK.has(host) && !config.server.tokenEnv) throw new Error('binding beyond loopback requires server.tokenEnv')
  const { token, source } = resolveToken(config, env)
  if (!LOOPBACK.has(host) && source === 'generated') {
    throw new Error(`binding to ${host} requires a fixed token in $${config.server.tokenEnv}`)
  }

  const root = new Hono()
  // Placeholder security until the real port is known (it may be 0); swapped in below before listening.
  let guard = apiGuard(createSecurity({ token, port: 1, hosts: [] }))
  root.use('/api/*', (c, next) => guard(c, next))
  root.use(
    '/api/*',
    bodyLimit({
      maxSize: MAX_BODY,
      // The unread remainder of the body would corrupt the next request on a kept-alive socket: close it.
      onError: (c) => {
        c.header('connection', 'close')
        return c.json({ error: 'request body too large' }, 413)
      },
    }),
  )
  root.route('/api', createApi(app))

  const staticDir = options.staticDir
  root.get('*', async (c) => {
    if (!staticDir) return c.json({ error: 'web UI not built (run pnpm --filter web build)' }, 404)
    const file = await staticFile(staticDir, c.req.path).catch(() => undefined)
    if (!file) return c.json({ error: 'not found' }, 404)
    c.header('content-type', file.type)
    c.header('x-content-type-options', 'nosniff')
    c.header('referrer-policy', 'no-referrer')
    c.header('x-frame-options', 'DENY')
    c.header('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    return c.body(new Uint8Array(file.body))
  })

  const server = serve({ fetch: root.fetch, hostname: host, port: options.port ?? config.server.port })
  if (!(server instanceof HttpServer)) throw new Error('expected an HTTP/1.1 server')
  await new Promise<void>((resolve, reject) => {
    if (server.listening) return resolve()
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  const port = (server.address() as AddressInfo).port
  const security = createSecurity({ token, port, hosts: allowedHosts(host), ...(options.devOrigins ? { devOrigins: options.devOrigins } : {}) })
  guard = apiGuard(security)
  const events = attachEventSocket(server, app, security)

  const displayHost = host.includes(':') ? `[${host}]` : host
  const url = `http://${displayHost}:${port}`
  return {
    url,
    port,
    uiUrl: `${url}/#token=${encodeURIComponent(token)}`,
    token,
    tokenSource: source,
    close: async () => {
      await events.close()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Long-lived NDJSON streams would otherwise keep the server open.
        if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
    },
  }
}
