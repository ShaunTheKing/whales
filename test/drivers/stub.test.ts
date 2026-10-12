import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { Context } from 'cordis'
import type {} from '../../src/contracts/index.ts'
import type { Driver, DriverEvent, TurnInput } from '../../src/contracts/index.ts'
import type { ToolSet } from '../../src/contracts/tools.ts'
import StubDriver from '../../src/drivers/stub.ts'

const emptyToolSet: ToolSet = {
  specs: [],
  invoke: async () => ({ output: '', isError: true }),
}

function makeInput(prompt: string, system = 'sys'): TurnInput {
  return {
    turnId: 'turn-1',
    system,
    history: [],
    prompt,
    tools: emptyToolSet,
  }
}

async function collect(iter: AsyncIterable<DriverEvent>): Promise<DriverEvent[]> {
  const events: DriverEvent[] = []
  for await (const ev of iter) events.push(ev)
  return events
}

function textDeltas(events: DriverEvent[]): string[] {
  const out: string[] = []
  for (const ev of events) if (ev.type === 'text') out.push(ev.delta)
  return out
}

function doneEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'done' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'done' }> => e.type === 'done')
}

function usageEvents(events: DriverEvent[]): Extract<DriverEvent, { type: 'usage' }>[] {
  return events.filter((e): e is Extract<DriverEvent, { type: 'usage' }> => e.type === 'usage')
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => resolve(socket))
    socket.once('error', reject)
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('StubDriver', () => {
  test('defaults: kind, model, capabilities', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, {})
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      assert.equal(d.kind, 'stub')
      assert.equal(d.model, 'stub-1')
      assert.deepEqual(d.capabilities, {
        tools: false,
        agentic: false,
        statefulSession: false,
      })
    } finally {
      await fiber.dispose()
    }
  })

  test('custom model is honoured', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { model: 'my-model' })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      assert.equal(d.model, 'my-model')
    } finally {
      await fiber.dispose()
    }
  })

  test('default template substitutes {prompt} and {model}', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, {})
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const events = await collect(d.run(makeInput('hello world'), new AbortController().signal))
      const text = textDeltas(events).join('')
      assert.equal(text, 'echo: hello world')
    } finally {
      await fiber.dispose()
    }
  })

  test('custom template substitutes {prompt} and {model}', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { model: 'm9', template: '[{model}] {prompt}!' })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const events = await collect(d.run(makeInput('ping'), new AbortController().signal))
      assert.equal(textDeltas(events).join(''), '[m9] ping!')
    } finally {
      await fiber.dispose()
    }
  })

  test('script order and cycling over 3 runs', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['one', 'two'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const sig = new AbortController().signal
      const r1 = await collect(d.run(makeInput('x'), sig))
      const r2 = await collect(d.run(makeInput('x'), sig))
      const r3 = await collect(d.run(makeInput('x'), sig))
      assert.equal(textDeltas(r1).join(''), 'one')
      assert.equal(textDeltas(r2).join(''), 'two')
      assert.equal(textDeltas(r3).join(''), 'one')
    } finally {
      await fiber.dispose()
    }
  })

  test('delta splitting reproduces the reply exactly', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['a b  c'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const events = await collect(d.run(makeInput('x'), new AbortController().signal))
      const deltas = textDeltas(events)
      assert.deepEqual(deltas, ['a', ' b', '  c'])
      assert.equal(deltas.join(''), 'a b  c')
    } finally {
      await fiber.dispose()
    }
  })

  test('empty reply emits no text events', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: [''] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const events = await collect(d.run(makeInput('x'), new AbortController().signal))
      assert.equal(textDeltas(events).length, 0)
      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(done[0]?.stopReason, 'end')
    } finally {
      await fiber.dispose()
    }
  })

  test('usage counts words in system+prompt and in reply', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['one two three'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const events = await collect(
        d.run(makeInput('hello there', 'sys prompt here'), new AbortController().signal),
      )
      const usage = usageEvents(events)
      assert.equal(usage.length, 1)
      // system 'sys prompt here' = 3 words, prompt 'hello there' = 2 words
      assert.equal(usage[0]?.inputTokens, 5)
      assert.equal(usage[0]?.outputTokens, 3)
    } finally {
      await fiber.dispose()
    }
  })

  test('exactly one done event and it is last', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['hi there'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const events = await collect(d.run(makeInput('x'), new AbortController().signal))
      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(events.at(-1)?.type, 'done')
      assert.equal(done[0]?.stopReason, 'end')
    } finally {
      await fiber.dispose()
    }
  })

  test('pre-aborted signal yields only done{cancelled}', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['hi there'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const ac = new AbortController()
      ac.abort()
      const events = await collect(d.run(makeInput('x'), ac.signal))
      assert.equal(events.length, 1)
      assert.equal(events[0]?.type, 'done')
      assert.equal(doneEvents(events)[0]?.stopReason, 'cancelled')
    } finally {
      await fiber.dispose()
    }
  })

  test('abort mid-run yields done{cancelled} last with fewer text events', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['one two three four five six'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const ac = new AbortController()
      const events: DriverEvent[] = []
      for await (const ev of d.run(makeInput('x'), ac.signal)) {
        events.push(ev)
        if (ev.type === 'text') ac.abort()
      }
      const done = doneEvents(events)
      assert.equal(done.length, 1)
      assert.equal(done[0]?.stopReason, 'cancelled')
      assert.equal(events.at(-1)?.type, 'done')
      assert.ok(textDeltas(events).length < 6)
      assert.equal(usageEvents(events).length, 0)
    } finally {
      await fiber.dispose()
    }
  })

  test('runs increments per completed run', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['a', 'b'] })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      assert.equal(d.runs, 0)
      const sig = new AbortController().signal
      await collect(d.run(makeInput('x'), sig))
      assert.equal(d.runs, 1)
      await collect(d.run(makeInput('x'), sig))
      assert.equal(d.runs, 2)
    } finally {
      await fiber.dispose()
    }
  })

  test('invalid config rejects the plugin', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { delayMs: -1 })
    await assert.rejects(Promise.resolve(fiber))
    await fiber.dispose()
  })

  test('invalid script entry rejects the plugin', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { script: ['ok', 42 as unknown as string] })
    await assert.rejects(Promise.resolve(fiber))
    await fiber.dispose()
  })

  test('listen: true opens a TCP port that closes on dispose', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { listen: true })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      const port = await d.port()
      assert.ok(port > 0)
      const socket = await connect(port)
      socket.destroy()
      await fiber.dispose()
      await assert.rejects(connect(port), (err: unknown) => {
        return (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
      })
    } finally {
      await fiber.dispose()
    }
  })

  test('port() rejects when listen is false', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, {})
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      await assert.rejects(d.port())
    } finally {
      await fiber.dispose()
    }
  })

  test('heartbeatMs increments ticks while active and stops after dispose', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, { heartbeatMs: 5 })
    try {
      await fiber
      const d = app.get('driver')
      assert.ok(d instanceof StubDriver)
      await delay(30)
      const before = d.ticks
      assert.ok(before > 0)
      await fiber.dispose()
      const afterDispose = d.ticks
      await delay(30)
      assert.equal(d.ticks, afterDispose)
    } finally {
      await fiber.dispose()
    }
  })

  test('service is removed after dispose', async () => {
    const app = new Context()
    const fiber = app.plugin(StubDriver, {})
    await fiber
    assert.ok(app.get('driver') instanceof StubDriver)
    await fiber.dispose()
    assert.equal(app.get('driver'), undefined)
  })
})
