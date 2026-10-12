// Lets an agent delegate a subtask to a DeepSeek model (a "worker"), like an orchestrator using cheap workers.
// The API key is read from an environment variable at call time; it is never part of the config or the prompt.
// Config: { model?: 'deepseek-chat' | 'deepseek-reasoner', apiKeyEnv?: string, baseUrl?: string, maxTokens?: number }
const DEFAULT_BASE = 'https://api.deepseek.com'
const MAX_BRIEF = 20000
const TIMEOUT_MS = 180000

export default {
  name: 'deepseek-delegate',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const model = typeof config.model === 'string' ? config.model : 'deepseek-chat'
    const keyEnv = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : 'DEEPSEEK_API_KEY'
    const base = typeof config.baseUrl === 'string' && config.baseUrl.startsWith('https://') ? config.baseUrl.replace(/\/$/, '') : DEFAULT_BASE
    const maxTokens = Number.isInteger(config.maxTokens) && config.maxTokens > 0 ? Math.min(config.maxTokens, 8192) : 4096

    ctx.tools.register({
      spec: {
        name: 'delegate_to_deepseek',
        description:
          `Send a self-contained subtask to a DeepSeek worker (${model}) and return its answer. ` +
          'The worker sees ONLY the brief: include all context it needs. Good for drafting, summarising, or bulk work.',
        inputSchema: {
          type: 'object',
          properties: {
            brief: { type: 'string', description: 'Complete, self-contained instructions for the worker.' },
            system: { type: 'string', description: 'Optional role/style for the worker.' },
          },
          required: ['brief'],
          additionalProperties: false,
        },
      },
      describe(input) {
        const brief = typeof input?.brief === 'string' ? input.brief : ''
        if (!brief.trim()) throw new Error('brief must be a non-empty string')
        if (brief.length > MAX_BRIEF) throw new Error(`brief must be at most ${MAX_BRIEF} characters`)
        return {
          kind: 'network',
          target: `${base}/chat/completions`,
          summary: `Delegate to ${model}: ${brief.slice(0, 120)}${brief.length > 120 ? '…' : ''}`,
          detail: { model, brief },
        }
      },
      async run(input, signal) {
        const key = process.env[keyEnv]
        if (!key) return { output: `${keyEnv} is not set in the environment`, isError: true }
        const messages = []
        if (typeof input.system === 'string' && input.system.trim()) messages.push({ role: 'system', content: input.system })
        messages.push({ role: 'user', content: input.brief })
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: false }),
        })
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 300).split(key).join('[redacted]')
          return { output: `DeepSeek returned HTTP ${res.status}: ${text}`, isError: true }
        }
        const data = await res.json()
        const answer = data?.choices?.[0]?.message?.content
        if (typeof answer !== 'string') return { output: 'DeepSeek returned no answer', isError: true }
        const usage = data.usage ? ` [${data.usage.prompt_tokens ?? '?'} in / ${data.usage.completion_tokens ?? '?'} out tokens]` : ''
        return { output: answer + usage, isError: false }
      },
    })
  },
}
