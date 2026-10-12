// Fetches a public http(s) page and returns readable text. Every call is a `network` action, so rules/approvals apply.
// Refuses loopback, private, link-local and .local/.internal hosts (by name and after DNS resolution), and follows
// redirects manually so each hop is checked again.
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

const MAX_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT = 20000
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 20000

function privateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7))
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') ||
    v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff')
}

async function checkUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http and https URLs are allowed')
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('local hosts are not allowed')
  }
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address)
  if (addresses.length === 0 || addresses.some(privateAddress)) throw new Error('private or local addresses are not allowed')
  return url
}

function toText(body, type) {
  if (!/html/i.test(type)) return body
  return body
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

export default {
  name: 'web-fetch',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      spec: {
        name: 'web_fetch',
        description: 'Fetch a public web page (http/https) and return it as plain text (truncated to 20k characters).',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
          required: ['url'],
          additionalProperties: false,
        },
      },
      describe(input) {
        if (typeof input?.url !== 'string') throw new Error('url must be a string')
        const url = new URL(input.url)
        return { kind: 'network', target: url.href, summary: `Fetch ${url.href}` }
      },
      async run(input, signal) {
        let url = await checkUrl(input.url)
        const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        for (let hop = 0; ; hop++) {
          const res = await fetch(url, { redirect: 'manual', signal: timeout, headers: { 'user-agent': 'whales-web-fetch/1.0', accept: 'text/html,text/plain,*/*;q=0.5' } })
          if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            if (hop >= MAX_REDIRECTS) return { output: 'too many redirects', isError: true }
            url = await checkUrl(new URL(res.headers.get('location'), url).href)
            continue
          }
          if (!res.ok) return { output: `HTTP ${res.status} from ${url.href}`, isError: true }
          const reader = res.body?.getReader()
          const chunks = []
          let size = 0
          while (reader) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            chunks.push(value)
            if (size >= MAX_BYTES) {
              await reader.cancel()
              break
            }
          }
          const text = toText(Buffer.concat(chunks).toString('utf8'), res.headers.get('content-type') ?? '')
          const clipped = text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated]` : text
          return { output: `${url.href}\n\n${clipped}`, isError: false }
        }
      },
    })
  },
}
