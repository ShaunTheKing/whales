import type { Context } from 'cordis'
import type { Tool } from '../contracts/tools.ts'
import { checkPublicUrl, fetchPublicText } from '../core/web.ts'
import { formatResults } from './search.ts'

/**
 * Built-in `web-search` agent plugin (orchestrator-owned). Two tools:
 *   - web_search {query, count?}: the configured search backend. Permission kind `tool` with target `web_search`, so the
 *     first search asks and "Allow always" means "this agent may search" (queries are shown on each card meanwhile).
 *   - web_open {url}: fetches a public page as text through core/web.ts (no local/private addresses). Permission kind
 *     `network` with the URL as target.
 * Works agent-wide or as a room plugin (room turns always ask).
 */

const MAX_PAGE_CHARS = 20_000

export interface WebSearchConfig {
  /** Results per search, 1–10 (default 5). */
  count?: number
  /** Register web_open too (default true). */
  open?: boolean
}

export const name = 'web-search'
export const inject = ['tools', 'agent']

export function apply(ctx: Context, config: WebSearchConfig = {}): void {
  const defaultCount = Number.isInteger(config.count) ? Math.min(Math.max(config.count!, 1), 10) : 5

  const search: Tool = {
    spec: {
      name: 'web_search',
      description:
        'Search the live web for current information (news, prices, docs, facts after your training data). ' +
        'Returns numbered results with titles, URLs and snippets. Cite results as [n].',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for, phrased like a search-engine query.' },
          count: { type: 'integer', minimum: 1, maximum: 10, description: `Number of results (default ${defaultCount}).` },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    describe(input) {
      const query = (input as { query?: unknown })?.query
      if (typeof query !== 'string' || !query.trim()) throw new Error('query must be a non-empty string')
      if (query.length > 400) throw new Error('query must be at most 400 characters')
      return { kind: 'tool', target: 'web_search', summary: `Search the web: ${query.trim().slice(0, 200)}`, detail: { query } }
    },
    async run(input, signal) {
      const { query, count } = input as { query: string; count?: number }
      const service = ctx.get('search')
      if (!service) return { output: 'web search is not available in this Whales instance', isError: true }
      try {
        const results = await service.search(query, { count: typeof count === 'number' ? count : defaultCount, signal })
        return { output: formatResults(query.trim(), results), isError: false }
      } catch (err) {
        return { output: err instanceof Error ? err.message : String(err), isError: true }
      }
    },
  }

  const open: Tool = {
    spec: {
      name: 'web_open',
      description: 'Open a public web page (http/https) and read it as plain text, e.g. a result from web_search. Max 20k characters.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
        required: ['url'],
        additionalProperties: false,
      },
    },
    describe(input) {
      const raw = (input as { url?: unknown })?.url
      if (typeof raw !== 'string') throw new Error('url must be a string')
      const url = checkPublicUrl(raw)
      return { kind: 'network', target: url.href, summary: `Open ${url.href.slice(0, 200)}` }
    },
    async run(input, signal) {
      try {
        const page = await fetchPublicText((input as { url: string }).url, { signal })
        if (page.status >= 400) return { output: `HTTP ${page.status} from ${page.url}`, isError: true }
        const clipped = page.text.length > MAX_PAGE_CHARS ? `${page.text.slice(0, MAX_PAGE_CHARS)}\n…[truncated]` : page.text
        return { output: `${page.url}\n\n${clipped}${page.truncated ? '\n…[page larger than 2 MB, cut]' : ''}`, isError: false }
      } catch (err) {
        return { output: `could not open the page: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  }

  ctx.tools.register(search)
  if (config.open !== false) ctx.tools.register(open)
  ctx.agent.addPromptSection({
    id: 'web-search',
    order: 150,
    render: () =>
      `You can search the live web with web_search${config.open !== false ? ' and read pages with web_open' : ''}. ` +
      `Today is ${new Date().toISOString().slice(0, 10)}. Use them for anything recent or that you are unsure about, and cite sources as [n] with links.`,
  })
}

/** Plain plugin object for the catalog (module namespace objects are frozen; Cordis may annotate plugins). */
export const WebSearch = { name, inject, apply }
