import type { Server as HttpServer, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { App } from '../core/app.ts'
import type { AgentHandle } from '../contracts/agents.ts'
import { upgradeAllowed, type Security } from './security.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Live event stream at /api/events.
 * Upgrade: Host + Origin checks. Then the client has 5 s to send `{"type":"auth","token":"…"}`; until then it
 * receives nothing. Slow consumers are disconnected instead of buffering without bound.
 */

const AUTH_TIMEOUT_MS = 5000
const MAX_BUFFERED = 4 * 1024 * 1024
const MAX_MESSAGE = 16 * 1024

function handleView(handle: AgentHandle): { id: string; name: string; state: string } {
  return { id: handle.id, name: handle.spec.name, state: handle.state }
}

export interface EventSocket {
  clients(): number
  close(): Promise<void>
}

export function attachEventSocket(server: HttpServer, app: App, security: Security): EventSocket {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE })
  const authed = new Set<WebSocket>()

  const broadcast = (type: string, data: unknown) => {
    const frame = JSON.stringify({ type, data })
    for (const ws of authed) {
      if (ws.bufferedAmount > MAX_BUFFERED) {
        ws.close(1013, 'client too slow')
        continue
      }
      ws.send(frame)
    }
  }

  const unsubscribe = [
    app.ctx.on('whales/agent-spawned', (handle) => broadcast('agent-spawned', handleView(handle))),
    app.ctx.on('whales/agent-disposed', (agentId) => broadcast('agent-disposed', { agentId })),
    app.ctx.on('whales/agent-event', (e) => broadcast('agent-event', e)),
    app.ctx.on('whales/turn-before', (t) => broadcast('turn-before', t)),
    app.ctx.on('whales/turn-after', (t) => broadcast('turn-after', t)),
    app.ctx.on('whales/approval-requested', (r) => broadcast('approval-requested', r)),
    app.ctx.on('whales/approval-resolved', (r) => broadcast('approval-resolved', r)),
    app.ctx.on('whales/room-event', (roomId, e) => broadcast('room-event', { roomId, event: e })),
    app.ctx.on('whales/routine-ran', (run) => broadcast('routine-ran', run)),
  ]

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? ''
    if (url !== '/api/events' && !url.startsWith('/api/events?')) return
    if (!upgradeAllowed(security, req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const timer = setTimeout(() => ws.close(4401, 'authentication timeout'), AUTH_TIMEOUT_MS)
      ws.once('message', (raw) => {
        clearTimeout(timer)
        let token: unknown
        try {
          const message: unknown = JSON.parse(String(raw))
          token = typeof message === 'object' && message !== null && 'type' in message && message.type === 'auth' && 'token' in message ? message.token : undefined
        } catch {
          token = undefined
        }
        if (typeof token !== 'string' || !security.tokenMatches(token)) {
          ws.close(4401, 'invalid token')
          return
        }
        authed.add(ws)
        ws.send(JSON.stringify({ type: 'ready', data: { agents: app.ctx.agents.list().map(handleView) } }))
        // The stream is server → client only; anything else the client sends is ignored.
      })
      ws.on('close', () => {
        clearTimeout(timer)
        authed.delete(ws)
      })
      ws.on('error', () => authed.delete(ws))
    })
  }
  server.on('upgrade', onUpgrade)

  return {
    clients: () => authed.size,
    close: async () => {
      server.off('upgrade', onUpgrade)
      for (const off of unsubscribe) off()
      for (const ws of wss.clients) ws.terminate()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    },
  }
}
