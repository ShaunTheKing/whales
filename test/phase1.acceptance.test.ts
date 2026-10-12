import type {} from '../src/contracts/index.ts'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import type { Context } from 'cordis'

import type { AgentHandle } from '../src/contracts/agents.ts'
import type { DriverEvent } from '../src/contracts/driver.ts'
import type { Tool } from '../src/contracts/tools.ts'

import { createApp, type App } from '../src/core/app.ts'
import { defaultConfig } from '../src/core/config.ts'
import { StubDriver } from '../src/drivers/stub.ts'

declare module 'cordis' {
  interface Events {
    'test/ping'(): void
  }
}

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-p1-'))

let app: App
let handleA: AgentHandle
let handleB: AgentHandle

let pingsX = 0
let pingsY = 0
let timerX = 0
let timerY = 0

let portA = 0
let portB = 0
let driverA: StubDriver | undefined
let driverB: StubDriver | undefined

const agentEventIds: string[] = []
const disposedIds: string[] = []

const xTool: Tool = {
  spec: {
    name: 'x_tool',
    description: 'x',
    inputSchema: { type: 'object', properties: {} },
  },
  describe: () => null,
  run: async () => ({ output: 'ok', isError: false }),
}

const yTool: Tool = {
  spec: {
    name: 'y_tool',
    description: 'y',
    inputSchema: { type: 'object', properties: {} },
  },
  describe: () => null,
  run: async () => ({ output: 'ok', isError: false }),
}

function probeX(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(xTool))
  ctx.on('test/ping', () => {
    pingsX += 1
  })
  ctx.effect(() => {
    const t = setInterval(() => {
      timerX += 1
    }, 5)
    return () => clearInterval(t)
  })
}

function probeY(ctx: Context): void {
  ctx.effect(() => ctx.tools.register(yTool))
  ctx.on('test/ping', () => {
    pingsY += 1
  })
  ctx.effect(() => {
    const t = setInterval(() => {
      timerY += 1
    }, 5)
    return () => clearInterval(t)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function runTurn(
  handle: AgentHandle,
  prompt: string,
): Promise<{ text: string; last: DriverEvent | undefined }> {
  const runtime = handle.runtime
  assert.ok(runtime, 'runtime must be defined')
  let text = ''
  let last: DriverEvent | undefined
  for await (const event of runtime.turn(prompt)) {
    if (event.type === 'text') text += event.delta
    last = event
  }
  return { text, last }
}

before(async () => {
  app = await createApp({
    config: defaultConfig({ env: {}, home: tmpHome, cwd: tmpHome }),
    storePath: ':memory:',
  })

  app.ctx.agents.catalog.register('probe-x', probeX)
  app.ctx.agents.catalog.register('probe-y', probeY)

  app.ctx.on('whales/agent-event', (e) => {
    agentEventIds.push(e.agentId)
  })
  app.ctx.on('whales/agent-disposed', (agentId) => {
    disposedIds.push(agentId)
  })

  handleA = await app.ctx.agents.spawn(
    {
      id: 'agent-a',
      name: 'A',
      seniority: 1,
      driver: {
        name: 'driver-stub',
        config: { listen: true, heartbeatMs: 5, template: 'A says {prompt}' },
      },
      plugins: [{ name: 'probe-x' }],
    },
    { persist: false },
  )

  handleB = await app.ctx.agents.spawn(
    {
      id: 'agent-b',
      name: 'B',
      seniority: 1,
      driver: {
        name: 'driver-stub',
        config: { listen: true, heartbeatMs: 5, template: 'B says {prompt}' },
      },
      plugins: [{ name: 'probe-y' }],
    },
    { persist: false },
  )
})

after(async () => {
  await app.stop()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('phase 1 acceptance', () => {
  test('both agents active', () => {
    assert.equal(handleA.state, 'active')
    assert.equal(handleB.state, 'active')
    assert.ok(handleA.runtime)
    assert.ok(handleB.runtime)
    const ids = app.ctx.agents.list().map((h) => h.id)
    assert.ok(ids.includes('agent-a'))
    assert.ok(ids.includes('agent-b'))
  })

  test('per-agent services are isolated', () => {
    const toolsA = handleA.ctx.get('tools')
    const toolsB = handleB.ctx.get('tools')
    assert.ok(toolsA)
    assert.ok(toolsB)
    assert.deepEqual(
      toolsA.list().map((s) => s.name),
      ['x_tool'],
    )
    assert.deepEqual(
      toolsB.list().map((s) => s.name),
      ['y_tool'],
    )

    assert.equal(app.ctx.get('tools'), undefined)
    assert.equal(app.ctx.get('driver'), undefined)
    assert.equal(app.ctx.get('agent'), undefined)

    const dA = handleA.ctx.get('driver')
    const dB = handleB.ctx.get('driver')
    assert.ok(dA instanceof StubDriver)
    assert.ok(dB instanceof StubDriver)
    assert.notStrictEqual(dA, dB)
    driverA = dA
    driverB = dB

    assert.equal(handleA.ctx.get('agent')?.id, 'agent-a')
    assert.equal(handleB.ctx.get('agent')?.id, 'agent-b')
  })

  test('both agents take turns', async () => {
    const a = await runTurn(handleA, 'hello')
    assert.equal(a.text, 'A says hello')
    assert.equal(a.last?.type, 'done')

    const b = await runTurn(handleB, 'hello')
    assert.equal(b.text, 'B says hello')
    assert.equal(b.last?.type, 'done')

    assert.ok(agentEventIds.includes('agent-a'))
    assert.ok(agentEventIds.includes('agent-b'))
  })

  test('everything is live before dispose', async () => {
    const beforeX = pingsX
    const beforeY = pingsY
    app.ctx.emit('test/ping')
    assert.equal(pingsX, beforeX + 1)
    assert.equal(pingsY, beforeY + 1)

    const tX = timerX
    const tY = timerY
    assert.ok(driverA)
    assert.ok(driverB)
    const ticksA = driverA.ticks
    const ticksB = driverB.ticks
    await sleep(30)
    assert.ok(timerX > tX)
    assert.ok(timerY > tY)
    assert.ok(driverA.ticks > ticksA)
    assert.ok(driverB.ticks > ticksB)

    portA = await driverA.port()
    portB = await driverB.port()
    assert.equal(await canConnect(portA), true)
    assert.equal(await canConnect(portB), true)
  })

  test('disposing A tears down only A', async () => {
    assert.equal(await app.ctx.agents.dispose('agent-a'), true)
    assert.equal(app.ctx.agents.get('agent-a'), undefined)
    assert.ok(disposedIds.includes('agent-a'))
    assert.equal(handleA.state, 'disposed')

    const beforeX = pingsX
    const beforeY = pingsY
    app.ctx.emit('test/ping')
    assert.equal(pingsX, beforeX)
    assert.equal(pingsY, beforeY + 1)

    const tX = timerX
    const tY = timerY
    assert.ok(driverA)
    assert.ok(driverB)
    const ticksA = driverA.ticks
    const ticksB = driverB.ticks
    await sleep(30)
    assert.equal(timerX, tX)
    assert.ok(timerY > tY)
    assert.equal(driverA.ticks, ticksA)
    assert.ok(driverB.ticks > ticksB)

    assert.equal(await canConnect(portA), false)
    assert.equal(await canConnect(portB), true)

    const b = await runTurn(handleB, 'again')
    assert.equal(b.text, 'B says again')

    assert.equal(await app.ctx.agents.dispose('nope'), false)
  })

  test('spawn validation', async () => {
    await assert.rejects(
      app.ctx.agents.spawn(
        {
          id: 'agent-b',
          name: 'B2',
          seniority: 1,
          driver: { name: 'driver-stub', config: {} },
          plugins: [],
        },
        { persist: false },
      ),
    )

    await assert.rejects(
      app.ctx.agents.spawn(
        {
          id: 'Bad Id',
          name: 'Bad',
          seniority: 1,
          driver: { name: 'driver-stub', config: {} },
          plugins: [],
        },
        { persist: false },
      ),
    )

    await assert.rejects(
      app.ctx.agents.spawn(
        {
          id: 'agent-c',
          name: 'C',
          seniority: 1,
          driver: { name: 'driver-stub', config: {} },
          plugins: [{ name: 'no-such-plugin' }],
        },
        { persist: false },
      ),
    )
    assert.equal(app.ctx.agents.get('agent-c'), undefined)
  })
})
