import { createHash } from 'node:crypto'
import { Service, type Context } from 'cordis'
import type {
  Driver,
  DriverCapabilities,
  DriverEvent,
  TurnInput,
  ChatMessage,
} from '../contracts/driver.ts'
import type { ProviderRecord, ProvidersService } from '../contracts/providers.ts'

export type Preset = 'deepseek' | 'openai' | 'openrouter' | 'ollama' | 'opencode'

export const PRESETS: Record<Preset, { baseUrl: string; apiKeyEnv?: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1' },
  opencode: { baseUrl: 'https://opencode.ai/zen/v1', apiKeyEnv: 'OPENCODE_API_KEY' },
}

export interface OpenAICompatConfig {
  /** Id of a provider saved on the Models page: base URL, default model and Keychain key come from it. */
  provider?: string
  preset?: Preset
  baseUrl?: string
  model?: string
  apiKeyEnv?: string
  temperature?: number
  maxTokens?: number
  idleTimeoutMs?: number
  maxRetries?: number
  tools?: boolean
  maxToolRounds?: number
}

const API_KEY_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const DEFAULT_IDLE_TIMEOUT_MS = 60000
const DEFAULT_MAX_RETRIES = 2
const DEFAULT_MAX_TOOL_ROUNDS = 8

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type WireMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface AccumulatedCall {
  index: number
  id: string
  name: string
  args: string
}

interface Usage {
  inputTokens: number
  outputTokens: number
}

type Outcome =
  | { kind: 'final'; stopReason: 'end' | 'max_tokens' | 'refused'; usage?: Usage; text: string }
  | { kind: 'tools'; calls: AccumulatedCall[]; usage?: Usage; text: string }
  | { kind: 'stopped' }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** OpenCode Go endpoints live under opencode.ai/zen/go. */
export function isOpenCodeGo(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.hostname === 'opencode.ai' && /^\/zen\/go(\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

function isPreset(v: unknown): v is Preset {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PRESETS, v)
}

function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--
  return s.slice(0, end)
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

function mapHistory(history: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = []
  for (const msg of history) {
    const content = msg.name ? `${msg.name}: ${msg.content}` : msg.content
    out.push({ role: msg.role, content })
  }
  return out
}

function buildMessages(input: TurnInput): WireMessage[] {
  const messages: WireMessage[] = []
  if (input.system !== '') {
    messages.push({ role: 'system', content: input.system })
  }
  for (const msg of mapHistory(input.history)) messages.push(msg)
  messages.push({ role: 'user', content: input.prompt })
  return messages
}

function toolsEnabled(config: OpenAICompatConfig): boolean {
  return config.tools !== false
}

/** Pure: builds the request body (exported for tests). */
export function buildBody(
  config: OpenAICompatConfig & { model: string },
  input: TurnInput,
  messages?: WireMessage[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: messages ?? buildMessages(input),
  }
  if (config.temperature !== undefined) body.temperature = config.temperature
  if (config.maxTokens !== undefined) body.max_tokens = config.maxTokens
  if (toolsEnabled(config) && input.tools.specs.length > 0) {
    body.tools = input.tools.specs.map((s) => ({
      type: 'function',
      function: { name: s.name, description: s.description, parameters: s.inputSchema },
    }))
    body.tool_choice = 'auto'
  }
  return body
}

export class OpenAICompatDriver extends Service implements Driver {
  readonly kind = 'openai-compat' as const
  readonly model: string
  readonly capabilities: DriverCapabilities
  readonly endpoint: string

  private readonly _baseUrl: string
  private readonly _apiKeyEnv: string | undefined
  private readonly _providers: ProvidersService | undefined = undefined
  private readonly _providerId: string | undefined = undefined
  private readonly _providerNeedsKey: boolean = false
  /** OpenCode Go requires a stable per-conversation `x-opencode-session` header (MissingSessionID otherwise). */
  private readonly _sessionHeader: boolean
  private readonly _actx: Context
  private readonly _temperature: number | undefined
  private readonly _maxTokens: number | undefined
  private readonly _idleTimeoutMs: number
  private readonly _maxRetries: number
  private readonly _maxToolRounds: number
  private readonly _tools: boolean
  private readonly _host: string

  constructor(ctx: Context, config: OpenAICompatConfig) {
    super(ctx, 'driver')

    if (!isRecord(config)) {
      throw new TypeError('driver-openai-compat: config must be an object')
    }

    let preset: { baseUrl: string; apiKeyEnv?: string } | undefined
    if (config.preset !== undefined) {
      if (!isPreset(config.preset)) {
        throw new TypeError('driver-openai-compat: preset must be one of deepseek, openai, openrouter, ollama, opencode')
      }
      preset = PRESETS[config.preset]
    }

    let provider: ProviderRecord | undefined
    if (config.provider !== undefined) {
      if (config.preset !== undefined || config.baseUrl !== undefined || config.apiKeyEnv !== undefined) {
        throw new TypeError('driver-openai-compat: provider cannot be combined with preset, baseUrl or apiKeyEnv')
      }
      const providers = ctx.get('providers')
      if (!providers) throw new TypeError('driver-openai-compat: the providers service is not running')
      provider = typeof config.provider === 'string' ? providers.get(config.provider) : undefined
      if (!provider) throw new TypeError(`driver-openai-compat: unknown provider ${JSON.stringify(config.provider)}`)
      this._providers = providers
      this._providerId = provider.id
      this._providerNeedsKey = provider.kind !== 'ollama' && provider.kind !== 'custom'
    }

    const model = config.model ?? provider?.defaultModel
    if (typeof model !== 'string' || model.length === 0) {
      throw new TypeError('driver-openai-compat: model must be a non-empty string')
    }

    const rawBaseUrl = config.baseUrl ?? provider?.baseUrl ?? preset?.baseUrl
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length === 0) {
      throw new TypeError('driver-openai-compat: baseUrl is required')
    }

    let url: URL
    try {
      url = new URL(rawBaseUrl)
    } catch {
      throw new TypeError('driver-openai-compat: baseUrl must be a valid URL')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError('driver-openai-compat: baseUrl protocol must be http: or https:')
    }
    if (url.username !== '' || url.password !== '') {
      throw new TypeError('driver-openai-compat: baseUrl must not contain credentials')
    }
    if (url.search !== '') {
      throw new TypeError('driver-openai-compat: baseUrl must not contain a query')
    }
    if (url.hash !== '') {
      throw new TypeError('driver-openai-compat: baseUrl must not contain a hash')
    }

    const baseUrl = stripTrailingSlashes(rawBaseUrl)

    let apiKeyEnv: string | undefined
    if (config.apiKeyEnv !== undefined) {
      if (typeof config.apiKeyEnv !== 'string' || !API_KEY_ENV_RE.test(config.apiKeyEnv)) {
        throw new TypeError('driver-openai-compat: apiKeyEnv must match /^[A-Z][A-Z0-9_]{0,63}$/')
      }
      apiKeyEnv = config.apiKeyEnv
    } else if (preset?.apiKeyEnv !== undefined) {
      apiKeyEnv = preset.apiKeyEnv
    }

    if (apiKeyEnv !== undefined && url.protocol === 'http:') {
      if (!LOOPBACK_HOSTS.has(url.hostname)) {
        throw new TypeError(
          'driver-openai-compat: refusing to send an API key over http: to a non-loopback host',
        )
      }
    }

    if (apiKeyEnv !== undefined) {
      const value = process.env[apiKeyEnv]
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`driver-openai-compat: environment variable ${apiKeyEnv} is not set`)
      }
    }

    if (config.temperature !== undefined) {
      if (
        typeof config.temperature !== 'number' ||
        !Number.isFinite(config.temperature) ||
        config.temperature < 0 ||
        config.temperature > 2
      ) {
        throw new TypeError('driver-openai-compat: temperature must be a finite number in [0, 2]')
      }
    }

    if (config.maxTokens !== undefined) {
      if (
        typeof config.maxTokens !== 'number' ||
        !Number.isInteger(config.maxTokens) ||
        config.maxTokens <= 0
      ) {
        throw new TypeError('driver-openai-compat: maxTokens must be a positive integer')
      }
    }

    if (config.idleTimeoutMs !== undefined) {
      if (
        typeof config.idleTimeoutMs !== 'number' ||
        !Number.isFinite(config.idleTimeoutMs) ||
        config.idleTimeoutMs <= 0
      ) {
        throw new TypeError('driver-openai-compat: idleTimeoutMs must be a finite number > 0')
      }
    }

    if (config.maxRetries !== undefined) {
      if (
        typeof config.maxRetries !== 'number' ||
        !Number.isInteger(config.maxRetries) ||
        config.maxRetries < 0 ||
        config.maxRetries > 5
      ) {
        throw new TypeError('driver-openai-compat: maxRetries must be an integer in [0, 5]')
      }
    }

    if (config.tools !== undefined && typeof config.tools !== 'boolean') {
      throw new TypeError('driver-openai-compat: tools must be a boolean')
    }

    if (config.maxToolRounds !== undefined) {
      if (
        typeof config.maxToolRounds !== 'number' ||
        !Number.isInteger(config.maxToolRounds) ||
        config.maxToolRounds < 1 ||
        config.maxToolRounds > 32
      ) {
        throw new TypeError('driver-openai-compat: maxToolRounds must be an integer in [1, 32]')
      }
    }

    this.model = model
    this._baseUrl = baseUrl
    this._apiKeyEnv = apiKeyEnv
    this._temperature = config.temperature
    this._maxTokens = config.maxTokens
    this._idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this._maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this._tools = config.tools !== false
    this._maxToolRounds = config.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS
    this.endpoint = `${baseUrl}/chat/completions`
    this._host = new URL(this.endpoint).host
    this._actx = ctx
    this._sessionHeader = provider?.kind === 'opencode-go' || isOpenCodeGo(baseUrl)
    this.capabilities = {
      tools: this._tools,
      agentic: false,
      statefulSession: false,
    }
  }

  private scrub(message: string): string {
    const env = this._apiKeyEnv
    if (env === undefined) return message
    const key = process.env[env]
    if (typeof key !== 'string' || key.length === 0) return message
    return message.split(key).join('[redacted]')
  }

  private buildHeaders(key: string | undefined, input: TurnInput): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    }
    if (key !== undefined) headers.authorization = `Bearer ${key}`
    if (this._sessionHeader) headers['x-opencode-session'] = this.sessionId(input)
    return headers
  }

  /**
   * One id per conversation: the agent's DM thread, or the agent's seat in a room. Stable across turns (so the
   * provider's prompt cache and routing work) but never shared between conversations (a single static id makes the
   * cache replay answers across unrelated chats). Hashed so agent and room ids are not sent verbatim.
   */
  private sessionId(input: TurnInput): string {
    const agentId = this._actx.get('agent')?.id ?? 'anonymous'
    const conversation = `whales\0${agentId}\0${input.roomId ?? 'dm'}`
    return `whales-${createHash('sha256').update(conversation).digest('hex').slice(0, 32)}`
  }

  async *run(input: TurnInput, signal: AbortSignal): AsyncIterable<DriverEvent> {
    if (signal.aborted) {
      yield { type: 'done', stopReason: 'cancelled' }
      return
    }

    const env = this._apiKeyEnv
    let key: string | undefined
    if (this._providers && this._providerId !== undefined) {
      try {
        key = await this._providers.resolveKey(this._providerId)
      } catch {
        key = undefined
      }
      if (!key && this._providerNeedsKey) {
        yield { type: 'error', message: `no API key saved for provider ${this._providerId} (add one on the Models page)` }
        yield { type: 'done', stopReason: 'error' }
        return
      }
    } else if (env !== undefined) {
      const value = process.env[env]
      if (typeof value !== 'string' || value.length === 0) {
        yield { type: 'error', message: this.scrub(`environment variable ${env} is not set`) }
        yield { type: 'done', stopReason: 'error' }
        return
      }
      key = value
    }

    // SECURITY: single choke point. Every error message leaving the driver is redacted with the exact
    // key used for this run (scrub() inside helpers is defence in depth, not the guarantee).
    const redact = (message: string): string => (key ? message.split(key).join('[redacted]') : message)
    try {
      for await (const event of this.converse(input, signal, key)) {
        yield event.type === 'error' ? { type: 'error', message: redact(event.message) } : event
      }
    } catch (err) {
      yield { type: 'error', message: redact(this.scrub(`request to ${this._host} failed: ${errorText(err)}`)) }
      yield { type: 'done', stopReason: 'error' }
    }
  }

  private async *converse(
    input: TurnInput,
    signal: AbortSignal,
    key: string | undefined,
  ): AsyncIterable<DriverEvent> {
    const messages = buildMessages(input)
    let totalInput = 0
    let totalOutput = 0
    let sawUsage = false
    let toolRounds = 0

    for (;;) {
      const outcome = yield* this.runAttempts(input, messages, signal, key)

      if (outcome.kind === 'stopped') return

      if (outcome.usage !== undefined) {
        totalInput += outcome.usage.inputTokens
        totalOutput += outcome.usage.outputTokens
        sawUsage = true
      }

      if (outcome.kind === 'final') {
        if (sawUsage) {
          yield { type: 'usage', inputTokens: totalInput, outputTokens: totalOutput }
        }
        yield { type: 'done', stopReason: outcome.stopReason }
        return
      }

      // outcome.kind === 'tools'. A tool round at the limit is refused BEFORE running anything: executing calls
      // whose results can never be sent back to the model would be side effects for nothing.
      if (toolRounds + 1 >= this._maxToolRounds) {
        yield { type: 'error', message: this.scrub(`tool round limit (${this._maxToolRounds}) reached`) }
        yield { type: 'done', stopReason: 'error' }
        return
      }
      toolRounds++

      const wireCalls: WireToolCall[] = []
      const toolMessages: WireMessage[] = []

      for (const call of outcome.calls) {
        if (signal.aborted) {
          yield { type: 'done', stopReason: 'cancelled' }
          return
        }

        const rawArgs = call.args === '' ? '{}' : call.args
        let parsed: unknown
        let parseError: string | undefined
        try {
          parsed = JSON.parse(rawArgs)
        } catch (err) {
          parseError = errorText(err)
        }

        let result: { output: string; isError: boolean }
        if (parseError !== undefined) {
          result = {
            output: `invalid JSON arguments for ${call.name}: ${parseError}`,
            isError: true,
          }
        } else {
          yield { type: 'tool_call', id: call.id, name: call.name, input: parsed }
          try {
            result = await input.tools.invoke({ id: call.id, name: call.name, input: parsed }, signal)
          } catch (err) {
            result = { output: errorText(err), isError: true }
          }
        }

        if (signal.aborted) {
          yield { type: 'done', stopReason: 'cancelled' }
          return
        }

        yield { type: 'tool_result', id: call.id, output: result.output, isError: result.isError }

        wireCalls.push({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: rawArgs },
        })
        toolMessages.push({ role: 'tool', tool_call_id: call.id, content: result.output })
      }

      messages.push({
        role: 'assistant',
        content: outcome.text === '' ? null : outcome.text,
        tool_calls: wireCalls,
      })
      for (const msg of toolMessages) messages.push(msg)
    }
  }

  private async *runAttempts(
    input: TurnInput,
    messages: WireMessage[],
    signal: AbortSignal,
    key: string | undefined,
  ): AsyncGenerator<DriverEvent, Outcome> {
    const body = JSON.stringify(buildBody({ ...this.configForBody(), model: this.model }, input, messages))
    const headers = this.buildHeaders(key, input)

    let attempt = 0
    for (;;) {
      if (signal.aborted) {
        yield { type: 'done', stopReason: 'cancelled' }
        return { kind: 'stopped' }
      }

      const controller = new AbortController()
      let cancelled = false
      let timedOut = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined

      const onCallerAbort = (): void => {
        cancelled = true
        controller.abort()
      }
      signal.addEventListener('abort', onCallerAbort, { once: true })

      const resetIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, this._idleTimeoutMs)
      }

      let response: Response | undefined
      let networkError: Error | undefined

      try {
        resetIdle()
        try {
          response = await fetch(this.endpoint, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
            // SECURITY: never follow redirects; a redirect could carry the Authorization header elsewhere.
            redirect: 'error',
          })
        } catch (err) {
          if (cancelled) {
            yield { type: 'done', stopReason: 'cancelled' }
            return { kind: 'stopped' }
          }
          if (timedOut) {
            yield { type: 'error', message: this.scrub(this.idleMessage()) }
            yield { type: 'done', stopReason: 'error' }
            return { kind: 'stopped' }
          }
          networkError = err instanceof Error ? err : new Error(String(err))
        }

        if (networkError !== undefined) {
          if (attempt < this._maxRetries) {
            const waited = await this.waitRetry(attempt, undefined, signal)
            if (!waited) {
              yield { type: 'done', stopReason: 'cancelled' }
              return { kind: 'stopped' }
            }
            attempt++
            continue
          }
          yield {
            type: 'error',
            message: this.scrub(`request to ${this._host} failed: ${networkError.message}`),
          }
          yield { type: 'done', stopReason: 'error' }
          return { kind: 'stopped' }
        }

        const res = response
        if (res === undefined) {
          yield {
            type: 'error',
            message: this.scrub(`request to ${this._host} failed: no response`),
          }
          yield { type: 'done', stopReason: 'error' }
          return { kind: 'stopped' }
        }

        if (!res.ok) {
          const text = (await readPrefix(res, 4096)).slice(0, 2000)
          const message = this.httpErrorMessage(res.status, text)
          if (RETRYABLE_STATUS.has(res.status) && attempt < this._maxRetries) {
            const retryAfter = res.headers.get('retry-after')
            const waited = await this.waitRetry(attempt, retryAfter, signal)
            if (!waited) {
              yield { type: 'done', stopReason: 'cancelled' }
              return { kind: 'stopped' }
            }
            attempt++
            continue
          }
          yield { type: 'error', message: this.scrub(message) }
          yield { type: 'done', stopReason: 'error' }
          return { kind: 'stopped' }
        }

        resetIdle()
        return yield* this.streamResponse(res, resetIdle, () => cancelled, () => timedOut)
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        signal.removeEventListener('abort', onCallerAbort)
      }
    }
  }

  private configForBody(): OpenAICompatConfig & { model: string } {
    const cfg: OpenAICompatConfig & { model: string } = { model: this.model }
    if (this._temperature !== undefined) cfg.temperature = this._temperature
    if (this._maxTokens !== undefined) cfg.maxTokens = this._maxTokens
    cfg.tools = this._tools
    return cfg
  }

  private idleMessage(): string {
    return `no data from ${this._host} for ${this._idleTimeoutMs}ms`
  }

  private httpErrorMessage(status: number, text: string): string {
    let detail = ''
    if (text.length > 0) {
      try {
        const parsed: unknown = JSON.parse(text)
        if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string') {
          detail = parsed.error.message
        }
      } catch {
        detail = ''
      }
      if (detail === '') detail = text.trim()
    }
    detail = detail.slice(0, 300)
    return `HTTP ${status} from ${this._host}: ${detail}`
  }

  private async waitRetry(
    attempt: number,
    retryAfter: string | null | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    let ms = Math.min(2 ** attempt * 500, 8000)
    if (retryAfter !== null && retryAfter !== undefined) {
      const seconds = Number(retryAfter)
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) {
        ms = seconds * 1000
      }
    }
    await abortableSleep(ms, signal)
    return !signal.aborted
  }

  /**
   * Parses the SSE body. `resetIdle` is called after every chunk so only *silence* times out,
   * never a long reply that is still streaming. Yields text/thinking/error events and returns
   * the outcome of the round (final answer, tool round, or already-stopped).
   */
  private async *streamResponse(
    res: Response,
    resetIdle: () => void,
    isCancelled: () => boolean,
    isTimedOut: () => boolean,
  ): AsyncGenerator<DriverEvent, Outcome> {
    if (res.body === null) {
      yield { type: 'error', message: 'invalid stream data' }
      yield { type: 'done', stopReason: 'error' }
      return { kind: 'stopped' }
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    const pending: DriverEvent[] = []
    let buffer = ''
    let stopReason: 'end' | 'max_tokens' | 'refused' = 'end'
    let usage: Usage | undefined
    let errorMessage: string | undefined
    let finished = false
    let text = ''
    const calls = new Map<number, AccumulatedCall>()
    const handlers = {
      onText: (delta: string) => {
        text += delta
        pending.push({ type: 'text', delta })
      },
      onThinking: (delta: string) => void pending.push({ type: 'thinking', delta }),
      onFinish: (reason: 'end' | 'max_tokens' | 'refused') => void (stopReason = reason),
      onUsage: (u: Usage) => void (usage = u),
      onError: (message: string) => void (errorMessage = message),
      onDone: () => void (finished = true),
      onToolCall: (fragment: ToolCallFragment) => {
        const existing = calls.get(fragment.index)
        if (existing === undefined) {
          calls.set(fragment.index, {
            index: fragment.index,
            id: fragment.id ?? `call_${fragment.index}`,
            name: fragment.name ?? '',
            args: fragment.args ?? '',
          })
          return
        }
        if (fragment.id !== undefined && existing.id === `call_${fragment.index}`) {
          existing.id = fragment.id
        }
        if (fragment.name !== undefined && existing.name === '') {
          existing.name = fragment.name
        }
        if (fragment.args !== undefined) existing.args += fragment.args
      },
    }
    const interrupted = (): DriverEvent[] | undefined => {
      if (isCancelled()) return [{ type: 'done', stopReason: 'cancelled' }]
      if (isTimedOut()) return [{ type: 'error', message: this.scrub(this.idleMessage()) }, { type: 'done', stopReason: 'error' }]
      return undefined
    }

    try {
      while (!finished) {
        let result: Awaited<ReturnType<typeof reader.read>>
        try {
          result = await reader.read()
        } catch (err) {
          const stop = interrupted()
          if (stop) {
            yield* stop
            return { kind: 'stopped' }
          }
          yield { type: 'error', message: this.scrub(`request to ${this._host} failed: ${errorText(err)}`) }
          yield { type: 'done', stopReason: 'error' }
          return { kind: 'stopped' }
        }
        const stop = interrupted()
        if (stop) {
          yield* stop
          return { kind: 'stopped' }
        }
        if (result.done) {
          buffer += decoder.decode()
          if (buffer.length > 0) this.handleLine(stripCR(buffer), handlers)
          buffer = ''
          yield* pending.splice(0)
          break
        }
        resetIdle()
        buffer += decoder.decode(result.value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1 && !finished) {
          const line = stripCR(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          this.handleLine(line, handlers)
          newline = buffer.indexOf('\n')
        }
        yield* pending.splice(0)
      }
    } finally {
      // The body may already be closed; a rejected cancel() carries no information.
      reader.cancel().catch(() => {})
    }

    if (errorMessage !== undefined) {
      yield { type: 'error', message: this.scrub(errorMessage) }
      yield { type: 'done', stopReason: 'error' }
      return { kind: 'stopped' }
    }

    const accumulated = [...calls.values()].sort((a, b) => a.index - b.index)
    if (accumulated.length > 0) {
      const outcome: Outcome = { kind: 'tools', calls: accumulated, text }
      if (usage !== undefined) outcome.usage = usage
      return outcome
    }

    const outcome: Outcome = { kind: 'final', stopReason, text }
    if (usage !== undefined) outcome.usage = usage
    return outcome
  }

  private handleLine(
    line: string,
    handlers: {
      onText: (delta: string) => void
      onThinking: (delta: string) => void
      onFinish: (reason: 'end' | 'max_tokens' | 'refused') => void
      onUsage: (usage: Usage) => void
      onError: (message: string) => void
      onDone: () => void
      onToolCall: (fragment: ToolCallFragment) => void
    },
  ): void {
    if (line.length === 0) return
    if (line.startsWith(':')) return
    if (!line.startsWith('data:')) return

    const payload = line.slice(5).trimStart()
    if (payload === '[DONE]') {
      handlers.onDone()
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      handlers.onError('invalid stream data')
      handlers.onDone()
      return
    }

    if (!isRecord(parsed)) return

    if (isRecord(parsed.error)) {
      const message =
        typeof parsed.error.message === 'string' ? parsed.error.message : 'stream error'
      handlers.onError(message)
      handlers.onDone()
      return
    }

    if (isRecord(parsed.usage)) {
      const inputTokens = parsed.usage.prompt_tokens
      const outputTokens = parsed.usage.completion_tokens
      if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
        handlers.onUsage({ inputTokens, outputTokens })
      }
    }

    const choices = parsed.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0]
      if (isRecord(choice)) {
        const delta = choice.delta
        if (isRecord(delta)) {
          const content = delta.content
          if (typeof content === 'string' && content.length > 0) {
            handlers.onText(content)
          }
          const reasoningContent = delta.reasoning_content
          if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
            handlers.onThinking(reasoningContent)
          }
          const reasoning = delta.reasoning
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            handlers.onThinking(reasoning)
          }
          const toolCalls = delta.tool_calls
          if (Array.isArray(toolCalls)) {
            for (const raw of toolCalls) {
              if (!isRecord(raw)) continue
              const index = raw.index
              if (typeof index !== 'number') continue
              const fragment: ToolCallFragment = { index }
              if (typeof raw.id === 'string') fragment.id = raw.id
              const fn = raw.function
              if (isRecord(fn)) {
                if (typeof fn.name === 'string') fragment.name = fn.name
                if (typeof fn.arguments === 'string') fragment.args = fn.arguments
              }
              handlers.onToolCall(fragment)
            }
          }
        }
        const finishReason = choice.finish_reason
        if (typeof finishReason === 'string') {
          if (finishReason === 'stop') handlers.onFinish('end')
          else if (finishReason === 'length') handlers.onFinish('max_tokens')
          else if (finishReason === 'content_filter') handlers.onFinish('refused')
          else handlers.onFinish('end')
        }
      }
    }
  }
}

interface ToolCallFragment {
  index: number
  id?: string
  name?: string
  args?: string
}

/** Reads at most `limit` bytes of a body as text, then cancels the rest. Never throws. */
async function readPrefix(res: Response, limit: number): Promise<string> {
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let bytes = 0
  try {
    while (bytes < limit) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } catch {
    // A truncated error body is still useful; the status code is reported regardless.
  } finally {
    reader.cancel().catch(() => {})
  }
  return text
}

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default OpenAICompatDriver
