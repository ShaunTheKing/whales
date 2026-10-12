import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { Service, type Context } from 'cordis'

import { createApp, type App } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import type {} from '../../src/contracts/index.ts'
import type { Action, PermissionMode } from '../../src/contracts/core.ts'
import type { ApprovalDecision, ApprovalRequest, ApprovalsService, Authorization } from '../../src/contracts/approvals.ts'
import type { Tool, ToolResult, ToolSet } from '../../src/contracts/tools.ts'

class FakeApprovals extends Service implements ApprovalsService {
  calls: { action: Action; mode: PermissionMode }[] = []
  private allow: boolean
  private throws: boolean

  constructor(ctx: Context, config: { allow: boolean; throws?: boolean }) {
    super(ctx, 'approvals')
    this.allow = config.allow
    this.throws = config.throws === true
  }

  async authorize(action: Action, opts: { mode: PermissionMode; signal?: AbortSignal }): Promise<Authorization> {
    this.calls.push({ action, mode: opts.mode })
    if (this.throws) throw new Error('boom from approvals')
    return { allowed: this.allow, via: 'rule', reason: this.allow ? 'ok' : 'denied by test' }
  }

  pending(): ApprovalRequest[] {
    return []
  }

  get(): ApprovalRequest | undefined {
    return undefined
  }

  answer(_id: string, _decision: ApprovalDecision, _note?: string): boolean {
    return false
  }
}

interface Harness {
  app: App
  home: string
  stop(): Promise<void>
}

async function makeApp(): Promise<Harness> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-tools-'))
  const app = await createApp({ config: defaultConfig({ env: {}, home, cwd: home }), storePath: ':memory:', services: { approvals: false } })
  return {
    app,
    home,
    async stop() {
      await app.stop()
      fs.rmSync(home, { recursive: true, force: true })
    },
  }
}

function makeTool(opts: {
  name: string
  describe?: (input: unknown) => Omit<Action, 'agentId' | 'roomId'> | null
  run?: (input: unknown, signal: AbortSignal) => Promise<ToolResult>
  counter?: { count: number }
}): Tool {
  const counter = opts.counter
  return {
    spec: {
      name: opts.name,
      description: `test tool ${opts.name}`,
      inputSchema: { type: 'object', properties: {} },
    },
    describe(input: unknown) {
      if (opts.describe) return opts.describe(input)
      return null
    },
    async run(input: unknown, signal: AbortSignal): Promise<ToolResult> {
      if (counter) counter.count += 1
      if (opts.run) return opts.run(input, signal)
      return { output: `ran ${opts.name}`, isError: false }
    },
  }
}

function registerToolPlugin(name: string, tool: Tool) {
  return {
    name,
    inject: ['tools'],
    apply: (ctx: Context) => {
      ctx.tools.register(tool)
    },
  }
}

async function spawnAgent(
  app: App,
  id: string,
  plugins: { name: string; inject: string[]; apply: (ctx: Context) => void }[],
  permissionMode?: PermissionMode,
) {
  return app.ctx.agents.spawn(
    {
      id,
      name: id,
      seniority: 1,
      driver: { name: 'driver-stub' },
      plugins: plugins.map((p) => ({ name: p.name })),
      ...(permissionMode ? { permissionMode } : {}),
    },
    { persist: false },
  )
}

function getTools(ctx: Context) {
  return ctx.get('tools')
}

test('register rejects invalid names', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    const tool = makeTool({ name: 'ok' })
    assert.throws(() => tools.register({ ...tool, spec: { ...tool.spec, name: 'Bad' } }), TypeError)
    assert.throws(() => tools.register({ ...tool, spec: { ...tool.spec, name: '1x' } }), TypeError)
    assert.throws(() => tools.register({ ...tool, spec: { ...tool.spec, name: 'a-b' } }), TypeError)
    assert.throws(() => tools.register({ ...tool, spec: { ...tool.spec, name: 'a'.repeat(65) } }), TypeError)
  } finally {
    await h.stop()
  }
})

test('register rejects duplicate names', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(makeTool({ name: 'dup' }))
    assert.throws(() => tools.register(makeTool({ name: 'dup' })), Error)
  } finally {
    await h.stop()
  }
})

test('register returns unregister and list preserves order', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    const un1 = tools.register(makeTool({ name: 'first' }))
    tools.register(makeTool({ name: 'second' }))
    tools.register(makeTool({ name: 'third' }))
    assert.deepEqual(
      tools.list().map((s) => s.name),
      ['first', 'second', 'third'],
    )
    un1()
    assert.deepEqual(
      tools.list().map((s) => s.name),
      ['second', 'third'],
    )
  } finally {
    await h.stop()
  }
})

test('plugin-registered tool disappears when agent is disposed', async () => {
  const h = await makeApp()
  try {
    const tool = makeTool({ name: 'plug' })
    h.app.ctx.agents.catalog.register('plug-tool', registerToolPlugin('plug-tool', tool))
    const handle = await spawnAgent(h.app, 'agent-a', [registerToolPlugin('plug-tool', tool)])
    const before = getTools(handle.ctx)
    assert.ok(before)
    assert.deepEqual(
      before.list().map((s) => s.name),
      ['plug'],
    )
    await h.app.ctx.agents.dispose('agent-a')
    const after = getTools(handle.ctx)
    if (after) {
      assert.ok(!after.list().some((s) => s.name === 'plug'))
    }
  } finally {
    await h.stop()
  }
})

test('tools are isolated per agent', async () => {
  const h = await makeApp()
  try {
    const toolA = makeTool({ name: 'only_a' })
    const toolB = makeTool({ name: 'only_b' })
    h.app.ctx.agents.catalog.register('tool-a', registerToolPlugin('tool-a', toolA))
    h.app.ctx.agents.catalog.register('tool-b', registerToolPlugin('tool-b', toolB))
    const a = await spawnAgent(h.app, 'agent-a', [registerToolPlugin('tool-a', toolA)])
    const b = await spawnAgent(h.app, 'agent-b', [registerToolPlugin('tool-b', toolB)])
    const toolsA = getTools(a.ctx)
    const toolsB = getTools(b.ctx)
    assert.ok(toolsA)
    assert.ok(toolsB)
    assert.deepEqual(
      toolsA.list().map((s) => s.name),
      ['only_a'],
    )
    assert.deepEqual(
      toolsB.list().map((s) => s.name),
      ['only_b'],
    )
  } finally {
    await h.stop()
  }
})

test('forTurn returns specs equal to list()', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(makeTool({ name: 'one' }))
    tools.register(makeTool({ name: 'two' }))
    const set = tools.forTurn({})
    assert.deepEqual(set.specs, tools.list())
  } finally {
    await h.stop()
  }
})

test('invoke unknown tool name', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'nope', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('unknown tool'))
  } finally {
    await h.stop()
  }
})

test('tool registered after forTurn is not invocable', async () => {
  const h = await makeApp()
  try {
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    const set = tools.forTurn({})
    tools.register(makeTool({ name: 'late' }))
    const res = await set.invoke({ id: 'c1', name: 'late', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('unknown tool'))
  } finally {
    await h.stop()
  }
})

test('describe throwing yields invalid input and does not run', async () => {
  const h = await makeApp()
  try {
    const counter = { count: 0 }
    const tool = makeTool({
      name: 'bad_describe',
      counter,
      describe: () => {
        throw new Error('nope')
      },
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'bad_describe', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('invalid input'))
    assert.equal(counter.count, 0)
  } finally {
    await h.stop()
  }
})

test('run throwing yields error message', async () => {
  const h = await makeApp()
  try {
    const tool = makeTool({
      name: 'bad_run',
      run: async () => {
        throw new Error('kaboom')
      },
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'bad_run', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('kaboom'))
  } finally {
    await h.stop()
  }
})

test('already aborted signal yields cancelled and does not run', async () => {
  const h = await makeApp()
  try {
    const counter = { count: 0 }
    const tool = makeTool({ name: 'aborted', counter })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const controller = new AbortController()
    controller.abort()
    const res = await set.invoke({ id: 'c1', name: 'aborted', input: {} }, controller.signal)
    assert.equal(res.isError, true)
    assert.equal(res.output, 'cancelled')
    assert.equal(counter.count, 0)
  } finally {
    await h.stop()
  }
})

test('side-effect-free tool runs without approvals service', async () => {
  const h = await makeApp()
  try {
    const counter = { count: 0 }
    const tool = makeTool({ name: 'free', counter, describe: () => null })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'free', input: {} }, new AbortController().signal)
    assert.equal(res.isError, false)
    assert.equal(counter.count, 1)
  } finally {
    await h.stop()
  }
})

test('side-effect-free tool does not call approvals', async () => {
  const h = await makeApp()
  try {
    await h.app.ctx.plugin(FakeApprovals, { allow: true })
    const counter = { count: 0 }
    const tool = makeTool({ name: 'free2', counter, describe: () => null })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'free2', input: {} }, new AbortController().signal)
    assert.equal(res.isError, false)
    assert.equal(counter.count, 1)
    const approvals = h.app.ctx.get('approvals')
    assert.ok(approvals instanceof FakeApprovals)
    assert.equal(approvals.calls.length, 0)
  } finally {
    await h.stop()
  }
})

test('side-effecting tool fails closed with no approvals service', async () => {
  const h = await makeApp()
  try {
    const counter = { count: 0 }
    const tool = makeTool({
      name: 'shell_no_approvals',
      counter,
      describe: () => ({ kind: 'shell', target: 'ls', summary: 'list' }),
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'shell_no_approvals', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('permission denied'))
    assert.equal(counter.count, 0)
  } finally {
    await h.stop()
  }
})

test('side-effecting tool denied by approvals', async () => {
  const h = await makeApp()
  try {
    await h.app.ctx.plugin(FakeApprovals, { allow: false })
    const counter = { count: 0 }
    const tool = makeTool({
      name: 'shell_denied',
      counter,
      describe: () => ({ kind: 'shell', target: 'ls', summary: 'list' }),
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'shell_denied', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('permission denied'))
    assert.ok(res.output.includes('denied by test'))
    assert.equal(counter.count, 0)
  } finally {
    await h.stop()
  }
})

test('side-effecting tool allowed records action and mode', async () => {
  const h = await makeApp()
  try {
    await h.app.ctx.plugin(FakeApprovals, { allow: true })
    const counter = { count: 0 }
    const tool = makeTool({
      name: 'shell_allowed',
      counter,
      describe: () => ({ kind: 'shell', target: 'ls', summary: 'list' }),
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'shell_allowed', input: {} }, new AbortController().signal)
    assert.equal(res.isError, false)
    assert.equal(counter.count, 1)
    const approvals = h.app.ctx.get('approvals')
    assert.ok(approvals instanceof FakeApprovals)
    assert.equal(approvals.calls.length, 1)
    const call = approvals.calls[0]
    assert.ok(call)
    assert.equal(call.action.kind, 'shell')
    assert.equal(call.action.target, 'ls')
    assert.equal(call.action.agentId, 'agent-a')
    assert.equal(call.action.roomId, undefined)
    assert.equal(call.mode, 'ask')
  } finally {
    await h.stop()
  }
})

test('trusted permission mode is recorded', async () => {
  const h = await makeApp()
  try {
    await h.app.ctx.plugin(FakeApprovals, { allow: true })
    const tool = makeTool({
      name: 'shell_trusted',
      describe: () => ({ kind: 'shell', target: 'ls', summary: 'list' }),
    })
    const handle = await spawnAgent(h.app, 'agent-a', [], 'trusted')
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    await set.invoke({ id: 'c1', name: 'shell_trusted', input: {} }, new AbortController().signal)
    const approvals = h.app.ctx.get('approvals')
    assert.ok(approvals instanceof FakeApprovals)
    const call = approvals.calls[0]
    assert.ok(call)
    assert.equal(call.mode, 'trusted')
  } finally {
    await h.stop()
  }
})

test('roomId is attached to the action', async () => {
  const h = await makeApp()
  try {
    await h.app.ctx.plugin(FakeApprovals, { allow: true })
    const tool = makeTool({
      name: 'shell_room',
      describe: () => ({ kind: 'shell', target: 'ls', summary: 'list' }),
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({ roomId: 'room-1' })
    await set.invoke({ id: 'c1', name: 'shell_room', input: {} }, new AbortController().signal)
    const approvals = h.app.ctx.get('approvals')
    assert.ok(approvals instanceof FakeApprovals)
    const call = approvals.calls[0]
    assert.ok(call)
    assert.equal(call.action.roomId, 'room-1')
  } finally {
    await h.stop()
  }
})

test('authorize throwing yields permission check failed and does not run', async () => {
  const h = await makeApp()
  try {
    await h.app.ctx.plugin(FakeApprovals, { allow: true, throws: true })
    const counter = { count: 0 }
    const tool = makeTool({
      name: 'shell_throws',
      counter,
      describe: () => ({ kind: 'shell', target: 'ls', summary: 'list' }),
    })
    const handle = await spawnAgent(h.app, 'agent-a', [])
    const tools = getTools(handle.ctx)
    assert.ok(tools)
    tools.register(tool)
    const set = tools.forTurn({})
    const res = await set.invoke({ id: 'c1', name: 'shell_throws', input: {} }, new AbortController().signal)
    assert.equal(res.isError, true)
    assert.ok(res.output.includes('permission check failed'))
    assert.equal(counter.count, 0)
  } finally {
    await h.stop()
  }
})
