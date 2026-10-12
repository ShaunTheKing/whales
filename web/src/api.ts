import type { AgentSpec, AgentView, ApprovalDecision, ApprovalRequest, Checkpoint, DmMessage, DriverEvent, FileChange, Room, RoomEvent, RoomMessage, RoomNote, ServerEvent } from './types.ts'

/**
 * SECURITY (orchestrator-owned). The API token arrives in the URL fragment (`#token=…`, never sent to the
 * server), is moved into sessionStorage (per tab, cleared when the tab closes) and removed from the address bar
 * and history. It is only ever sent in the Authorization header and the first WebSocket message.
 */

const STORAGE_KEY = 'whales.token'

function readToken(): string | undefined {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash)
  if (match?.[1]) {
    const token = decodeURIComponent(match[1])
    try {
      sessionStorage.setItem(STORAGE_KEY, token)
    } catch {
      // Storage can be unavailable (private mode); the token still works for this page load.
    }
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return token
  }
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? undefined
  } catch {
    return undefined
  }
}

let token = readToken()

export function hasToken(): boolean {
  return token !== undefined
}

export function setToken(value: string): void {
  token = value.trim()
  try {
    sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    // see readToken
  }
}

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  if (signal) init.signal = signal
  const res = await fetch(`/api${path}`, init)
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const data: unknown = await res.json()
      if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') message = data.error
    } catch {
      // non-JSON error body: keep the status text
    }
    throw new ApiError(res.status, message)
  }
  return res
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await request(method, path, body)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Streams newline-delimited JSON objects from a response body. */
async function* ndjson<T>(res: Response): AsyncGenerator<T> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield JSON.parse(line) as T
        newline = buffer.indexOf('\n')
      }
      if (done) break
    }
    if (buffer.trim()) yield JSON.parse(buffer) as T
  } finally {
    reader.releaseLock()
  }
}

export const api = {
  health: () => json<{ ok: boolean; agents: number; pendingApprovals: number }>('GET', '/health'),

  agents: () => json<AgentView[]>('GET', '/agents'),
  agent: (id: string) => json<{ agent: AgentView; spec: AgentSpec }>('GET', `/agents/${encodeURIComponent(id)}`),
  createAgent: (spec: AgentSpec) => json<AgentView>('POST', '/agents', { spec }),
  deleteAgent: (id: string, forget = false) => json<void>('DELETE', `/agents/${encodeURIComponent(id)}${forget ? '?forget=1' : ''}`),
  startAgent: (id: string) => json<AgentView>('POST', `/agents/${encodeURIComponent(id)}/start`),
  stopAgent: (id: string) => json<AgentView>('POST', `/agents/${encodeURIComponent(id)}/stop`),
  messages: (id: string, limit = 200) => json<DmMessage[]>('GET', `/agents/${encodeURIComponent(id)}/messages?limit=${limit}`),
  /** Streams one DM turn. Abort the signal to cancel the turn on the server. */
  async *turn(id: string, prompt: string, signal?: AbortSignal): AsyncGenerator<DriverEvent> {
    yield* ndjson<DriverEvent>(await request('POST', `/agents/${encodeURIComponent(id)}/turn`, { prompt }, signal))
  },

  rooms: () => json<Room[]>('GET', '/rooms'),
  room: (id: string) => json<{ room: Room; order: string[]; notes: RoomNote[] }>('GET', `/rooms/${encodeURIComponent(id)}`),
  createRoom: (name: string, members: string[]) => json<Room>('POST', '/rooms', { name, members }),
  deleteRoom: (id: string) => json<void>('DELETE', `/rooms/${encodeURIComponent(id)}`),
  roomMessages: (id: string, limit = 200) => json<RoomMessage[]>('GET', `/rooms/${encodeURIComponent(id)}/messages?limit=${limit}`),
  addNote: (id: string, text: string) => json<RoomNote>('POST', `/rooms/${encodeURIComponent(id)}/notes`, { text }),
  /** Streams one room round. */
  async *post(id: string, content: string, signal?: AbortSignal): AsyncGenerator<RoomEvent> {
    yield* ndjson<RoomEvent>(await request('POST', `/rooms/${encodeURIComponent(id)}/post`, { content }, signal))
  },

  approvals: () => json<ApprovalRequest[]>('GET', '/approvals'),
  answer: (id: string, decision: ApprovalDecision) => json<{ ok: true }>('POST', `/approvals/${encodeURIComponent(id)}`, { decision }),

  checkpoints: (agentId: string) => json<Checkpoint[]>('GET', `/agents/${encodeURIComponent(agentId)}/checkpoints`),
  snapshot: (agentId: string, label: string) => json<Checkpoint>('POST', `/agents/${encodeURIComponent(agentId)}/checkpoints`, { label }),
  diff: (id: string, to?: string) =>
    json<{ changes: FileChange[]; patch: string }>(
      'GET',
      `/checkpoints/${encodeURIComponent(id)}/diff${to ? `?to=${encodeURIComponent(to)}` : ''}`,
    ),
  restore: (id: string) => json<{ safety: Checkpoint }>('POST', `/checkpoints/${encodeURIComponent(id)}/restore`),
}

export type Unsubscribe = () => void

/**
 * Live server events with automatic reconnect (1 s → 15 s backoff). `onStatus` reports connection state.
 * A close with code 4401 means the token was rejected: no reconnect.
 */
export function subscribe(onEvent: (event: ServerEvent) => void, onStatus: (status: 'connecting' | 'open' | 'closed' | 'unauthorized') => void): Unsubscribe {
  let socket: WebSocket | undefined
  let stopped = false
  let delay = 1000
  let timer: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    if (stopped) return
    onStatus('connecting')
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${scheme}://${window.location.host}/api/events`)
    socket.onopen = () => socket?.send(JSON.stringify({ type: 'auth', token: token ?? '' }))
    socket.onmessage = (message) => {
      try {
        const event = JSON.parse(String(message.data)) as ServerEvent
        if (event.type === 'ready') {
          delay = 1000
          onStatus('open')
        }
        onEvent(event)
      } catch {
        // Ignore malformed frames rather than tearing down the UI.
      }
    }
    socket.onclose = (close) => {
      socket = undefined
      if (stopped) return
      if (close.code === 4401) {
        onStatus('unauthorized')
        return
      }
      onStatus('closed')
      timer = setTimeout(connect, delay)
      delay = Math.min(delay * 2, 15000)
    }
  }
  connect()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    socket?.close()
  }
}
