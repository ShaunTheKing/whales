import { Service, type Context } from 'cordis'
import type { MemoryNote, MemoryService, ScoredNote } from '../contracts/memory.ts'
import type { Tool, ToolResult } from '../contracts/tools.ts'
import type { PromptContext } from '../contracts/agents.ts'
import { newId } from '../core/ids.ts'

export interface MemoryConfig {
  /** Default number of notes returned by `recall`. Integer 1..20. Default 5. */
  recallLimit?: number
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'is', 'are', 'was', 'were',
  'be', 'been', 'it', 'this', 'that', 'you', 'your', 'i', 'me', 'my', 'we', 'our', 'they', 'them', 'their',
  'he', 'she', 'his', 'her', 'as', 'by', 'from', 'not', 'no', 'do', 'does', 'did', 'have', 'has', 'had',
  'will', 'would', 'can', 'could', 'should', 'what', 'which', 'who', 'how', 'when', 'where', 'why', 'if',
  'then', 'than', 'so', 'just', 'about', 'into', 'over', 'also',
])

const TAG_RE = /^[a-z0-9-]{1,32}$/
const MAX_TAGS = 8
const MAX_TEXT = 2000
const K1 = 1.2
const B = 0.75

/** Lower-case, split on non-alphanumeric, drop empties, short tokens and stopwords. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue
    if (STOPWORDS.has(raw)) continue
    out.push(raw)
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class Memory extends Service implements MemoryService {
  static inject = ['agent', 'store', 'tools']

  private readonly agentId: string
  private readonly scope: `agent:${string}`
  private readonly store: Context['store']
  private readonly recallLimit: number

  constructor(ctx: Context, config?: MemoryConfig) {
    super(ctx, 'memory')

    const limit = config?.recallLimit ?? 5
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new TypeError(`memory: recallLimit must be an integer 1..20, got ${JSON.stringify(config?.recallLimit)}`)
    }
    this.recallLimit = limit

    this.agentId = ctx.agent.id
    this.scope = `agent:${this.agentId}`
    this.store = ctx.store

    ctx.agent.addPromptSection({
      id: 'memory',
      order: 200,
      render: (promptCtx: PromptContext): string => {
        const results = this.recall(promptCtx.prompt)
        if (results.length === 0) return ''
        const lines = results.map((r) => `- ${r.note.text}`)
        return `Relevant notes from your memory:\n${lines.join('\n')}`
      },
    })

    ctx.tools.register(this.buildTool())
  }

  remember(text: string, opts?: { tags?: string[]; source?: MemoryNote['source'] }): MemoryNote {
    if (typeof text !== 'string') {
      throw new TypeError('memory.remember: text must be a string')
    }
    const trimmed = text.trim()
    if (trimmed.length < 1 || trimmed.length > MAX_TEXT) {
      throw new TypeError(`memory.remember: text must be 1..${MAX_TEXT} characters`)
    }

    const tags = this.normalizeTags(opts?.tags)

    const note: MemoryNote = {
      id: newId('mem'),
      scope: this.scope,
      createdAt: Date.now(),
      text: trimmed,
      tags,
    }
    if (opts?.source !== undefined) {
      note.source = opts.source
    }

    this.store.collection('memories').put(note)
    return note
  }

  recall(query: string, limit?: number): ScoredNote[] {
    const effective = limit ?? this.recallLimit
    if (typeof effective !== 'number' || !Number.isInteger(effective) || effective < 1 || effective > 50) {
      throw new RangeError(`memory.recall: limit must be an integer 1..50, got ${JSON.stringify(limit)}`)
    }

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const notes = this.list()
    if (notes.length === 0) return []

    const docs = notes.map((note) => {
      const tokens = tokenize(note.text)
      for (const tag of note.tags) {
        for (const t of tokenize(tag)) tokens.push(t)
      }
      const tf = new Map<string, number>()
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      return { note, tf, length: tokens.length }
    })

    const n = docs.length
    let totalLength = 0
    for (const d of docs) totalLength += d.length
    const avgdl = totalLength / n

    const df = new Map<string, number>()
    for (const token of new Set(queryTokens)) {
      let count = 0
      for (const d of docs) {
        if (d.tf.has(token)) count += 1
      }
      df.set(token, count)
    }

    const scored: ScoredNote[] = []
    for (const d of docs) {
      let raw = 0
      for (const token of queryTokens) {
        const f = d.tf.get(token)
        if (f === undefined || f === 0) continue
        const docFreq = df.get(token) ?? 0
        const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5))
        const denom = f + K1 * (1 - B + (B * d.length) / avgdl)
        raw += idf * ((f * (K1 + 1)) / denom)
      }
      if (raw > 0) {
        scored.push({ note: d.note, score: raw / (raw + 1) })
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.note.createdAt - a.note.createdAt
    })

    const top = scored.slice(0, effective)
    const now = Date.now()
    const collection = this.store.collection('memories')
    for (const entry of top) {
      const updated: MemoryNote = { ...entry.note, lastUsedAt: now }
      collection.put(updated)
      entry.note = updated
    }
    return top
  }

  list(): MemoryNote[] {
    return this.store.collection('memories').list({ scope: this.scope, order: 'asc' })
  }

  forget(id: string): boolean {
    const collection = this.store.collection('memories')
    const existing = collection.get(id)
    if (!existing) return false
    if (existing.scope !== this.scope) return false
    return collection.delete(id)
  }

  private normalizeTags(tags: string[] | undefined): string[] {
    if (tags === undefined) return []
    if (!Array.isArray(tags)) {
      throw new TypeError('memory.remember: tags must be an array of strings')
    }
    const out: string[] = []
    for (const tag of tags) {
      if (typeof tag !== 'string') {
        throw new TypeError('memory.remember: each tag must be a string')
      }
      const normalized = tag.trim().toLowerCase()
      if (!TAG_RE.test(normalized)) {
        throw new TypeError(`memory.remember: invalid tag ${JSON.stringify(tag)}`)
      }
      if (!out.includes(normalized)) out.push(normalized)
    }
    if (out.length > MAX_TAGS) {
      throw new TypeError(`memory.remember: at most ${MAX_TAGS} tags`)
    }
    return out
  }

  private buildTool(): Tool {
    const self = this
    return {
      spec: {
        name: 'remember',
        description:
          'Save a short note to your long-term memory. Use it for facts, preferences and decisions worth keeping.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      describe(input: unknown): null {
        self.parseToolInput(input)
        return null
      },
      async run(input: unknown): Promise<ToolResult> {
        try {
          const parsed = self.parseToolInput(input)
          const note = self.remember(parsed.text, parsed.tags ? { tags: parsed.tags } : undefined)
          return { output: `Saved note ${note.id}`, isError: false }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: message, isError: true }
        }
      },
    }
  }

  private parseToolInput(input: unknown): { text: string; tags?: string[] } {
    if (!isRecord(input)) {
      throw new TypeError('remember: input must be an object')
    }
    const text = input['text']
    if (typeof text !== 'string') {
      throw new TypeError('remember: `text` must be a string')
    }
    const rawTags = input['tags']
    if (rawTags === undefined) {
      return { text }
    }
    if (!Array.isArray(rawTags)) {
      throw new TypeError('remember: `tags` must be an array of strings')
    }
    const tags: string[] = []
    for (const tag of rawTags) {
      if (typeof tag !== 'string') {
        throw new TypeError('remember: `tags` must be an array of strings')
      }
      tags.push(tag)
    }
    return { text, tags }
  }
}

export default Memory
