import type { Context } from 'cordis'
import type { DriverEvent } from '../contracts/driver.ts'
import type {} from '../contracts/agents.ts'
import type {} from '../contracts/approvals.ts'

export interface TelegramConfig {
  tokenEnv?: string
  allowedChatIds: number[]
  apiBase?: string
  pollTimeoutSec?: number
}

const DEFAULT_TOKEN_ENV = 'TELEGRAM_BOT_TOKEN'
const DEFAULT_API_BASE = 'https://api.telegram.org'
const DEFAULT_POLL_TIMEOUT_SEC = 25
const TOKEN_ENV_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const CALLBACK_RE = /^a:([a-z]+_[0-9a-z]+):(once|always|deny)$/
const MAX_BACKOFF_MS = 30_000
const PREVIEW_LIMIT = 500

export function chunkText(text: string, max = 4000): string[] {
  if (text.length <= max) {
    return [text]
  }
  const chunks: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const nl = window.lastIndexOf('\n')
    const cut = nl > 0 ? nl + 1 : max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) {
    chunks.push(rest)
  }
  return chunks
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
}

function validateConfig(config: TelegramConfig): void {
  const ids = config.allowedChatIds
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new TypeError('bridge-telegram: allowedChatIds must be a non-empty array')
  }
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new TypeError('bridge-telegram: allowedChatIds must contain safe integers')
    }
  }
  const tokenEnv = config.tokenEnv ?? DEFAULT_TOKEN_ENV
  if (typeof tokenEnv !== 'string' || !TOKEN_ENV_RE.test(tokenEnv)) {
    throw new TypeError('bridge-telegram: tokenEnv must match /^[A-Z][A-Z0-9_]{0,63}$/')
  }
  const apiBase = config.apiBase ?? DEFAULT_API_BASE
  let parsed: URL
  try {
    parsed = new URL(apiBase)
  } catch {
    throw new TypeError('bridge-telegram: apiBase must be a valid URL')
  }
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHost(parsed.hostname)) {
      throw new TypeError('bridge-telegram: apiBase must use https:// (http:// only for loopback)')
    }
  } else if (parsed.protocol !== 'https:') {
    throw new TypeError('bridge-telegram: apiBase must use https:// (http:// only for loopback)')
  }
  const timeout = config.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 0 || timeout > 50) {
    throw new TypeError('bridge-telegram: pollTimeoutSec must be an integer 0..50')
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

interface IncomingMessage {
  chatId: number
  text: string
}

interface IncomingCallback {
  chatId: number
  id: string
  data: string
}

function parseMessage(update: Record<string, unknown>): IncomingMessage | undefined {
  const message = update.message
  if (!isRecord(message)) {
    return undefined
  }
  const chat = message.chat
  if (!isRecord(chat)) {
    return undefined
  }
  const chatId = chat.id
  const text = message.text
  if (typeof chatId !== 'number' || typeof text !== 'string') {
    return undefined
  }
  return { chatId, text }
}

function parseCallback(update: Record<string, unknown>): IncomingCallback | undefined {
  const query = update.callback_query
  if (!isRecord(query)) {
    return undefined
  }
  const id = query.id
  const data = query.data
  const message = query.message
  if (typeof id !== 'string' || typeof data !== 'string' || !isRecord(message)) {
    return undefined
  }
  const chat = message.chat
  if (!isRecord(chat)) {
    return undefined
  }
  const chatId = chat.id
  if (typeof chatId !== 'number') {
    return undefined
  }
  return { chatId, id, data }
}

export const TelegramBridge = {
  name: 'bridge-telegram',
  inject: ['agent'],
  apply(ctx: Context, config: TelegramConfig): void {
    validateConfig(config)

    const tokenEnv = config.tokenEnv ?? DEFAULT_TOKEN_ENV
    const apiBase = config.apiBase ?? DEFAULT_API_BASE
    const pollTimeoutSec = config.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC
    const allowed = new Set(config.allowedChatIds)

    const token = process.env[tokenEnv]
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError(`bridge-telegram: environment variable ${tokenEnv} is not set`)
    }

    const agent = ctx.agent
    const agentId = agent.id
    const agentName = agent.spec.name
    const logger = ctx.logger('telegram')
    const warnedChats = new Set<number>()

    const redact = (message: string): string => message.split(token).join('[redacted]')

    const api = async (
      method: string,
      body: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<unknown> => {
      const response = await fetch(`${apiBase}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
        redirect: 'error',
      })
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      const description =
        isRecord(payload) && typeof payload.description === 'string' ? payload.description : ''
      if (!response.ok || !isRecord(payload) || payload.ok !== true) {
        throw new Error(
          redact(`telegram ${method} failed: HTTP ${response.status} ${description}`.trim()),
        )
      }
      return payload.result
    }

    const warnUnknownChat = (chatId: number): void => {
      if (warnedChats.has(chatId)) {
        return
      }
      warnedChats.add(chatId)
      logger.warn(`ignoring chat ${chatId}: not in allowedChatIds`)
    }

    const sendMessage = async (
      chatId: number,
      text: string,
      signal: AbortSignal,
      replyMarkup?: Record<string, unknown>,
    ): Promise<void> => {
      const body: Record<string, unknown> = { chat_id: chatId, text }
      if (replyMarkup !== undefined) {
        body.reply_markup = replyMarkup
      }
      await api('sendMessage', body, signal)
    }

    const handleMessage = async (
      message: IncomingMessage,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!allowed.has(message.chatId)) {
        warnUnknownChat(message.chatId)
        return
      }
      if (message.text === '/start') {
        await sendMessage(message.chatId, `Connected to ${agentName}.`, signal)
        return
      }
      await api('sendChatAction', { chat_id: message.chatId, action: 'typing' }, signal)
      let reply = ''
      let failure: string | undefined
      for await (const event of agent.turn(message.text, { signal })) {
        if (event.type === 'text') {
          reply += event.delta
        } else if (event.type === 'error') {
          failure = event.message
        } else if (event.type === 'done' && event.stopReason !== 'end') {
          failure = failure ?? event.stopReason
        }
      }
      if (failure !== undefined) {
        await sendMessage(message.chatId, `⚠️ ${redact(failure)}`, signal)
        return
      }
      const text = reply.length > 0 ? reply : '(no reply)'
      for (const chunk of chunkText(text)) {
        await sendMessage(message.chatId, chunk, signal)
      }
    }

    const handleCallback = async (
      callback: IncomingCallback,
      signal: AbortSignal,
    ): Promise<void> => {
      if (!allowed.has(callback.chatId)) {
        warnUnknownChat(callback.chatId)
        return
      }
      const match = CALLBACK_RE.exec(callback.data)
      if (match === null) {
        await api(
          'answerCallbackQuery',
          { callback_query_id: callback.id, text: 'Invalid' },
          signal,
        )
        return
      }
      const id = match[1] ?? ''
      const verb = match[2]
      const decision = verb === 'once' ? 'allow-once' : verb === 'always' ? 'allow-always' : 'deny'
      const answered = ctx.get('approvals')?.answer(id, decision) ?? false
      await api(
        'answerCallbackQuery',
        { callback_query_id: callback.id, text: answered ? 'Done' : 'Already handled' },
        signal,
      )
    }

    const handleUpdate = async (
      update: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<void> => {
      const message = parseMessage(update)
      if (message !== undefined) {
        // Not awaited: a turn may block on an approval whose answer arrives as a LATER update (an inline-button
        // callback), so polling must continue. The agent runtime still runs turns one at a time, in order.
        void handleMessage(message, signal).catch((error: unknown) => {
          if (!signal.aborted && !isAbortError(error)) logger.warn(redact(error instanceof Error ? error.message : String(error)))
        })
        return
      }
      const callback = parseCallback(update)
      if (callback !== undefined) {
        await handleCallback(callback, signal)
      }
    }

    const loop = async (signal: AbortSignal): Promise<void> => {
      let offset: number | undefined
      let backoff = 1000
      for (;;) {
        if (signal.aborted) {
          return
        }
        let result: unknown
        try {
          result = await api(
            'getUpdates',
            { offset, timeout: pollTimeoutSec, allowed_updates: ['message', 'callback_query'] },
            signal,
          )
          backoff = 1000
        } catch (error) {
          if (signal.aborted || isAbortError(error)) {
            return
          }
          logger.warn(redact(error instanceof Error ? error.message : String(error)))
          try {
            await sleep(backoff, signal)
          } catch {
            return
          }
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
          continue
        }
        if (!Array.isArray(result)) {
          continue
        }
        for (const raw of result) {
          if (!isRecord(raw)) {
            continue
          }
          const updateId = raw.update_id
          if (typeof updateId === 'number') {
            offset = updateId + 1
          }
          try {
            await handleUpdate(raw, signal)
          } catch (error) {
            if (signal.aborted || isAbortError(error)) {
              return
            }
            logger.warn(redact(error instanceof Error ? error.message : String(error)))
          }
        }
      }
    }

    ctx.effect(() => {
      const controller = new AbortController()
      void loop(controller.signal).catch((error: unknown) => {
        if (!isAbortError(error)) {
          logger.warn(redact(error instanceof Error ? error.message : String(error)))
        }
      })
      return () => controller.abort()
    })

    ctx.on('whales/approval-requested', (req) => {
      if (req.action.agentId !== agentId) {
        return
      }
      const controller = new AbortController()
      const detail = req.action.detail
      const preview =
        isRecord(detail) && typeof detail.preview === 'string'
          ? detail.preview.slice(0, PREVIEW_LIMIT)
          : undefined
      let text = `Approval needed: ${req.action.summary}\n${req.action.kind} ${req.action.target}\n${req.reason}`
      if (preview !== undefined) {
        text += `\n\n${preview}`
      }
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: 'Allow once', callback_data: `a:${req.id}:once` },
            { text: 'Always', callback_data: `a:${req.id}:always` },
            { text: 'Deny', callback_data: `a:${req.id}:deny` },
          ],
        ],
      }
      for (const chatId of allowed) {
        void sendMessage(chatId, text, controller.signal, replyMarkup).catch((error: unknown) => {
          logger.warn(redact(error instanceof Error ? error.message : String(error)))
        })
      }
    })
  },
}
