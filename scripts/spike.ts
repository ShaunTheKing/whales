import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import type { Context } from 'cordis'
import type {} from '../src/contracts/index.ts'
import { createApp } from '../src/core/app.ts'
import { defaultConfig } from '../src/core/config.ts'
import { StubDriver } from '../src/drivers/stub.ts'
import type { AgentHandle } from '../src/contracts/agents.ts'
import type { Tool } from '../src/contracts/tools.ts'

declare module 'cordis' {
  interface Events {
    'spike/ping'(): void
  }
}

let checks = 0
let failed = 0

function ok(desc: string): void {
  checks += 1
  console.log(`[ok] ${desc}`)
}

function fail(desc: string, detail: string): void {
  checks += 1
  failed += 1
  console.log(`[FAIL] ${desc}: ${detail}`)
}

function check(desc: string, cond: boolean, detail = 'condition false'): void {
  if (cond) ok(desc)
  else fail(desc, detail)
}

interface Counters { readonly pings: number; readonly intervals: number }
const counters = new Map<string, Counters>()

function makePlugin(toolName: string, output: string): { inject: string[]; apply: (ctx: Context) => void } {
  return {
    inject: ['tools'],
    apply(ctx: Context) {
      const tool: Tool = {
        spec: {
          name: toolName,
          description: `${toolName} demo`,
          inputSchema: { type: 'object', properties: {} },
        },
        describe: () => null,
        run: async () => ({ output, isError: false }),
      }
      ctx.tools.register(tool)
      let pings = 0
      let intervals = 0
      ctx.on('spike/ping', () => { pings += 1 })
      ctx.effect(() => {
        const t = setInterval(() => { intervals += 1 }, 10)
        return () => clearInterval(t)
      })
      counters.set(toolName, { get pings() { return pings }, get intervals() { return intervals } })
    },
  }
}



function toolNames(ctx: Context): string[] {
  const tools = ctx.get('tools')
  if (!tools) return []
  return tools.list().map((s) => s.name)
}

function driverOf(ctx: Context): StubDriver | undefined {
  const d = ctx.get('driver')
  return d instanceof StubDriver ? d : undefined
}

function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'whales-spike-'))
  const app = await createApp({
    config: defaultConfig({ env: {}, home, cwd: home }),
    storePath: ':memory:',
  })

  try {
    app.ctx.agents.catalog.register('plugin-x', makePlugin('x_tool', 'x'))
    app.ctx.agents.catalog.register('plugin-y', makePlugin('y_tool', 'y'))
    ok('registered catalog plugins plugin-x and plugin-y')

    const a = await app.ctx.agents.spawn({
      id: 'agent-a',
      name: 'Alice',
      seniority: 2,
      driver: { name: 'driver-stub', config: { template: 'Alice heard: {prompt}', listen: true, heartbeatMs: 10 } },
      plugins: [{ name: 'plugin-x' }],
    }, { persist: false })
    const b = await app.ctx.agents.spawn({
      id: 'agent-b',
      name: 'Bob',
      seniority: 1,
      driver: { name: 'driver-stub', config: { template: 'Bob heard: {prompt}', listen: true, heartbeatMs: 10 } },
      plugins: [{ name: 'plugin-y' }],
    }, { persist: false })
    ok('spawned agent-a and agent-b')

    const aTools = toolNames(a.ctx)
    const bTools = toolNames(b.ctx)
    const aDriver = driverOf(a.ctx)
    const bDriver = driverOf(b.ctx)
    const aPort = aDriver ? await aDriver.port() : -1
    const bPort = bDriver ? await bDriver.port() : -1

    console.table([
      { id: a.id, tools: aTools.join(','), model: aDriver?.model ?? 'none', port: aPort },
      { id: b.id, tools: bTools.join(','), model: bDriver?.model ?? 'none', port: bPort },
    ])

    check('A sees only x_tool', aTools.length === 1 && aTools[0] === 'x_tool', JSON.stringify(aTools))
    check('B sees only y_tool', bTools.length === 1 && bTools[0] === 'y_tool', JSON.stringify(bTools))
    check('root has no tools service', app.ctx.get('tools') === undefined)
    check('root has no driver service', app.ctx.get('driver') === undefined)
    check('A and B drivers are distinct objects', aDriver !== undefined && bDriver !== undefined && aDriver !== bDriver)

    const aRuntime = a.runtime
    const bRuntime = b.runtime
    if (!aRuntime || !bRuntime) {
      fail('runtimes available', 'runtime undefined')
    } else {
      let aReply = ''
      for await (const ev of aRuntime.turn('hello')) {
        if (ev.type === 'text') aReply += ev.delta
      }
      let bReply = ''
      for await (const ev of bRuntime.turn('hello')) {
        if (ev.type === 'text') bReply += ev.delta
      }
      console.log(`A reply: ${aReply}`)
      console.log(`B reply: ${bReply}`)
      check('A reply matches template', aReply.includes('Alice heard: hello'), aReply)
      check('B reply matches template', bReply.includes('Bob heard: hello'), bReply)
    }

    const aCounters = counters.get('x_tool')
    const bCounters = counters.get('y_tool')
    const aPings0 = aCounters ? aCounters.pings : -1
    const bPings0 = bCounters ? bCounters.pings : -1
    app.ctx.emit('spike/ping')
    check('A ping counter +1', aCounters !== undefined && aCounters.pings === aPings0 + 1, `${aPings0} -> ${aCounters?.pings}`)
    check('B ping counter +1', bCounters !== undefined && bCounters.pings === bPings0 + 1, `${bPings0} -> ${bCounters?.pings}`)

    const aInt0 = aCounters ? aCounters.intervals : -1
    const bInt0 = bCounters ? bCounters.intervals : -1
    const aTicks0 = aDriver ? aDriver.ticks : -1
    const bTicks0 = bDriver ? bDriver.ticks : -1
    await sleep(50)
    check('A interval increased', aCounters !== undefined && aCounters.intervals > aInt0, `${aInt0} -> ${aCounters?.intervals}`)
    check('B interval increased', bCounters !== undefined && bCounters.intervals > bInt0, `${bInt0} -> ${bCounters?.intervals}`)
    check('A driver ticks increased', aDriver !== undefined && aDriver.ticks > aTicks0, `${aTicks0} -> ${aDriver?.ticks}`)
    check('B driver ticks increased', bDriver !== undefined && bDriver.ticks > bTicks0, `${bTicks0} -> ${bDriver?.ticks}`)

    const aTcp0 = await tcpProbe(aPort)
    const bTcp0 = await tcpProbe(bPort)
    check('A TCP port accepts', aTcp0, `port ${aPort}`)
    check('B TCP port accepts', bTcp0, `port ${bPort}`)

    const disposed = await app.ctx.agents.dispose('agent-a')
    check('dispose(agent-a) returned true', disposed === true)
    check('agents.get(agent-a) is undefined', app.ctx.agents.get('agent-a') === undefined)

    const aPings1 = aCounters ? aCounters.pings : -1
    const bPings1 = bCounters ? bCounters.pings : -1
    app.ctx.emit('spike/ping')
    check('A ping counter frozen after dispose', aCounters !== undefined && aCounters.pings === aPings1, `${aPings1} -> ${aCounters?.pings}`)
    check('B ping counter +1 after A dispose', bCounters !== undefined && bCounters.pings === bPings1 + 1, `${bPings1} -> ${bCounters?.pings}`)

    const aInt1 = aCounters ? aCounters.intervals : -1
    const aTicks1 = aDriver ? aDriver.ticks : -1
    const bInt1 = bCounters ? bCounters.intervals : -1
    const bTicks1 = bDriver ? bDriver.ticks : -1
    await sleep(50)
    check('A interval frozen after dispose', aCounters !== undefined && aCounters.intervals === aInt1, `${aInt1} -> ${aCounters?.intervals}`)
    check('A driver ticks frozen after dispose', aDriver !== undefined && aDriver.ticks === aTicks1, `${aTicks1} -> ${aDriver?.ticks}`)
    check('B interval still increasing', bCounters !== undefined && bCounters.intervals > bInt1, `${bInt1} -> ${bCounters?.intervals}`)
    check('B driver ticks still increasing', bDriver !== undefined && bDriver.ticks > bTicks1, `${bTicks1} -> ${bDriver?.ticks}`)

    const aTcp1 = await tcpProbe(aPort)
    const bTcp1 = await tcpProbe(bPort)
    check('A TCP port refused after dispose', aTcp1 === false, `port ${aPort}`)
    check('B TCP port still accepts', bTcp1 === true, `port ${bPort}`)

    if (!bRuntime) {
      fail('B runtime available for second turn', 'runtime undefined')
    } else {
      let bReply2 = ''
      for await (const ev of bRuntime.turn('still there?')) {
        if (ev.type === 'text') bReply2 += ev.delta
      }
      console.log(`B reply 2: ${bReply2}`)
      check('B second turn works', bReply2.includes('Bob heard: still there?'), bReply2)
    }
  } finally {
    console.log(`Phase 1 spike: ${checks} checks, ${failed} failed`)
    await app.stop()
    rmSync(home, { recursive: true, force: true })
  }

  process.exitCode = failed ? 1 : 0
}

main().catch((err: unknown) => {
  console.error('[FAIL] spike crashed:', err)
  process.exitCode = 1
})
