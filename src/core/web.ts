import { lookup as dnsLookup } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Fetching pages on behalf of an agent.
 *
 * Agents choose the URL, so this must never reach the user's own machine or network (router admin pages, local dev
 * servers, cloud metadata endpoints). Defences:
 *   - http/https only, no credentials in URLs, no `localhost` / `.local` / `.internal` names;
 *   - every address is checked INSIDE the socket's DNS lookup, so the address we vet is the one we connect to
 *     (no DNS-rebinding window between "check" and "connect");
 *   - redirects are followed manually, each hop re-checked, at most 5;
 *   - size and time limits; only text-ish content types are decoded.
 */

const MAX_REDIRECTS = 5
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT = 20_000
const USER_AGENT = 'Whales/1.0 (+local agent; web_open)'

export class BlockedAddressError extends Error {}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const parts = ip.split('.').map(Number)
    const [a = 0, b = 0] = parts
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  if (v === 6) {
    const x = ip.toLowerCase()
    if (x.startsWith('::ffff:')) {
      const tail = x.slice(7)
      if (isIP(tail) === 4) return isPrivateAddress(tail)
      // ::ffff:7f00:1 form
      const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
      if (m) {
        const hi = parseInt(m[1] ?? '0', 16)
        const lo = parseInt(m[2] ?? '0', 16)
        return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
      }
      return true
    }
    return (
      x === '::' ||
      x === '::1' ||
      x.startsWith('fc') ||
      x.startsWith('fd') ||
      /^fe[89ab]/.test(x) ||
      x.startsWith('ff') ||
      x.startsWith('64:ff9b:') ||
      x.startsWith('2001:db8') ||
      x.startsWith('2002:')
    )
  }
  return true
}

/** Throws unless the URL is an http(s) URL to a public-looking host. Does not resolve DNS (the lookup hook does). */
export function checkPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedAddressError('not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BlockedAddressError('only http and https URLs are allowed')
  if (url.username || url.password) throw new BlockedAddressError('URLs with credentials are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new BlockedAddressError('local hosts are not allowed')
  }
  if (isIP(host) && isPrivateAddress(host)) throw new BlockedAddressError('private or local addresses are not allowed')
  return url
}

/** DNS lookup used by the socket itself: vets every resolved address before the connection is made. */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0)
    const list = Array.isArray(addresses) ? addresses : []
    if (list.length === 0) return callback(new BlockedAddressError(`${hostname} did not resolve`), '', 0)
    const bad = list.find((a) => isPrivateAddress(a.address))
    if (bad) return callback(new BlockedAddressError(`${hostname} resolves to a private or local address`), '', 0)
    if (options.all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list)
    const first = list[0]!
    callback(null, first.address, first.family)
  })
}

export interface FetchedPage {
  url: string
  status: number
  contentType: string
  text: string
  truncated: boolean
}

interface Hop {
  status: number
  headers: http.IncomingHttpHeaders
  body: Readable
}

function request(url: URL, signal: AbortSignal, lookup: LookupFunction): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup,
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-encoding': 'gzip, deflate, br' },
      },
      (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }),
    )
    req.on('error', reject)
    req.end()
  })
}

function decoded(hop: Hop): Readable {
  const encoding = String(hop.headers['content-encoding'] ?? '').toLowerCase()
  if (encoding === 'gzip') return hop.body.pipe(createGunzip())
  if (encoding === 'deflate') return hop.body.pipe(createInflate())
  if (encoding === 'br') return hop.body.pipe(createBrotliDecompress())
  return hop.body
}

async function readCapped(stream: Readable, max: number): Promise<{ buffer: Buffer; truncated: boolean }> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    chunks.push(buf)
    size += buf.length
    if (size >= max) {
      stream.destroy()
      return { buffer: Buffer.concat(chunks).subarray(0, max), truncated: true }
    }
  }
  return { buffer: Buffer.concat(chunks), truncated: false }
}

/** Fetch a public page as text (HTML is reduced to readable text). Throws BlockedAddressError for local targets. */
export async function fetchPublicText(
  raw: string,
  opts: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number; /** Tests only: resolve test hostnames to a local server. */ lookup?: LookupFunction } = {},
): Promise<FetchedPage> {
  const lookup = opts.lookup ?? guardedLookup
  const signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT)])
  let url = checkPublicUrl(raw)
  for (let hop = 0; ; hop++) {
    const res = await request(url, signal, lookup)
    const location = res.headers.location
    if (res.status >= 300 && res.status < 400 && location) {
      res.body.resume()
      if (hop >= MAX_REDIRECTS) throw new Error('too many redirects')
      url = checkPublicUrl(new URL(location, url).href)
      continue
    }
    const contentType = String(res.headers['content-type'] ?? '')
    if (!/^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml))/i.test(contentType) && contentType !== '') {
      res.body.resume()
      return { url: url.href, status: res.status, contentType, text: `(not a text page: ${contentType})`, truncated: false }
    }
    const { buffer, truncated } = await readCapped(decoded(res), opts.maxBytes ?? DEFAULT_MAX_BYTES)
    const body = buffer.toString('utf8')
    return { url: url.href, status: res.status, contentType, text: /html/i.test(contentType) ? htmlToText(body) : body, truncated }
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

/** Crude but safe HTML → text: drops scripts/styles/nav chrome, keeps paragraph breaks and link text. */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim()
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '
      }
      return ENTITIES[code.toLowerCase()] ?? m
    })
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return title ? `${title}\n\n${text}` : text
}
