import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { MiddlewareHandler } from 'hono'
import type { WhalesConfig } from '../contracts/config.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). A local API server is reachable by every website the user visits
 * (cross-site requests, DNS rebinding), so even on 127.0.0.1 every /api request must pass:
 *  1. Host check   — the Host header must name this server (defeats DNS rebinding).
 *  2. Origin check — a browser Origin, when present, must be this server's own origin (or an allowed dev origin).
 *  3. Bearer token — constant-time compared. Browsers cannot attach it cross-site without reading it first.
 * WebSockets get checks 1–2 at upgrade and must authenticate with the token in their first message.
 */

export interface SecurityOptions {
  token: string
  port: number
  /** Hostnames this server answers to (lower-case, IPv6 in brackets). */
  hosts: string[]
  /** Extra browser origins allowed, e.g. the Vite dev server `http://localhost:5173`. */
  devOrigins?: string[]
}

export interface Security {
  readonly token: string
  hostAllowed(hostHeader: string | undefined): boolean
  originAllowed(origin: string | undefined): boolean
  tokenMatches(candidate: string | undefined): boolean
}

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']
const MIN_TOKEN_LENGTH = 24

/** Token from `config.server.tokenEnv` if set (must be ≥ 24 chars), else a fresh random one per server start. */
export function resolveToken(config: WhalesConfig, env: Record<string, string | undefined>): { token: string; source: 'env' | 'generated' } {
  const name = config.server.tokenEnv
  const fromEnv = name ? env[name] : undefined
  if (fromEnv !== undefined && fromEnv !== '') {
    if (fromEnv.length < MIN_TOKEN_LENGTH) throw new Error(`${name} must be at least ${MIN_TOKEN_LENGTH} characters`)
    return { token: fromEnv, source: 'env' }
  }
  return { token: randomBytes(32).toString('base64url'), source: 'generated' }
}

/** Hostnames to accept: loopback names plus the configured bind host (unless it is a wildcard address). */
export function allowedHosts(bindHost: string): string[] {
  const hosts = new Set(LOOPBACK)
  const normalized = bindHost.includes(':') && !bindHost.startsWith('[') ? `[${bindHost}]` : bindHost.toLowerCase()
  if (normalized !== '0.0.0.0' && normalized !== '[::]') hosts.add(normalized)
  return [...hosts]
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Splits a Host header into hostname and port. Returns undefined for anything malformed. */
function parseHost(header: string): { hostname: string; port: string } | undefined {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(header.trim())
  if (!match) return undefined
  return { hostname: (match[1] ?? '').toLowerCase(), port: match[2] ?? '' }
}

export function createSecurity(options: SecurityOptions): Security {
  if (options.token.length < MIN_TOKEN_LENGTH) throw new Error('server token is too short')
  const hosts = new Set(options.hosts.map((h) => h.toLowerCase()))
  const port = String(options.port)
  const origins = new Set<string>(options.devOrigins ?? [])
  for (const host of hosts) origins.add(`http://${host}:${port}`)
  const expected = digest(options.token)

  return {
    token: options.token,
    hostAllowed(hostHeader) {
      if (!hostHeader) return false
      const parsed = parseHost(hostHeader)
      return parsed !== undefined && hosts.has(parsed.hostname) && parsed.port === port
    },
    originAllowed(origin) {
      // Non-browser clients (CLI, curl) send no Origin; they still need the token.
      return origin === undefined || origins.has(origin)
    },
    tokenMatches(candidate) {
      if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) return false
      return timingSafeEqual(digest(candidate), expected)
    },
  }
}

/** Hono middleware for /api/*: host → origin → token. Responses never echo the token. */
export function apiGuard(security: Security): MiddlewareHandler {
  return async (c, next) => {
    if (!security.hostAllowed(c.req.header('host'))) return c.json({ error: 'unexpected Host header' }, 421)
    if (!security.originAllowed(c.req.header('origin'))) return c.json({ error: 'cross-origin request refused' }, 403)
    const auth = c.req.header('authorization')
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    if (!security.tokenMatches(token)) {
      c.header('www-authenticate', 'Bearer')
      return c.json({ error: 'missing or invalid token' }, 401)
    }
    await next()
  }
}

/** Upgrade-time checks for WebSockets (authentication happens in the first message). */
export function upgradeAllowed(security: Security, req: IncomingMessage): boolean {
  const origin = req.headers.origin
  return security.hostAllowed(req.headers.host) && security.originAllowed(Array.isArray(origin) ? origin[0] : origin)
}
