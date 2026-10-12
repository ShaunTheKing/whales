import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createApp } from '../../src/core/app.ts'
import { defaultConfig } from '../../src/core/config.ts'
import type { Action, PermissionMode } from '../../src/contracts/core.ts'
import type { ApprovalRequest } from '../../src/contracts/approvals.ts'
import type { Rule } from '../../src/contracts/rules.ts'
import type {} from '../../src/contracts/index.ts'

interface Harness {
  app: Awaited<ReturnType<typeof createApp>>
  approvals: NonNullable<ReturnType<Harness['app']['ctx']['get']>>
  rules: NonNullable<ReturnType<Harness['app']['ctx']['get']>>
  tmp: string
}

async function makeApp(storePath?: string): Promise<Harness> {
  const tmp = await mkdtemp(path.join(tmpdir(), 'whales-appr-'))
  const app = await createApp({
    config: defaultConfig({ env: {}, home: tmp, cwd: tmp }),
    storePath: storePath ?? ':memory:',
  })
  const approvals = app.ctx.get('approvals')
  const rules = app.ctx.get('rules')
  assert.ok(approvals, 'approvals service installed')
  assert.ok(rules, 'rules service installed')
  return { app, approvals, rules, tmp }
}

async function stopApp(h: Harness): Promise<void> {
  await h.app.stop()
  await rm(h.tmp, { recursive: true, force: true })
}

function shellAction(over: Partial<Action> = {}): Action {
  return {
    kind: 'shell',
    target: 'ls -la',
    agentId: 'a1',
    summary: 'list files',
    ...over,
  }
}

/** Race a promise against a 30ms timer; returns 'pending' if it did not settle. */
async function racePending<T>(p: Promise<T>): Promise<T | 'pending'> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), 30)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function collectEvents<T>(h: Harness, name: string): T[] {
  const seen: T[] = []
  h.app.ctx.on(name as never, ((payload: T) => {
    seen.push(payload)
  }) as never)
  return seen
}

test('deny rule blocks immediately, no request, no event', async () => {
  const h = await makeApp()
  try {
    h.rules.add('deny running commands matching rm *')
    const requested = collectEvents<ApprovalRequest>(h, 'whales/approval-requested')
    const res = await h.approvals.authorize(shellAction({ target: 'rm -rf x' }), { mode: 'ask' })
    assert.equal(res.allowed, false)
    assert.equal(res.via, 'rule')
    assert.match(res.reason, /rm \*/)
    assert.equal(h.approvals.pending().length, 0)
    assert.equal(requested.length, 0)
  } finally {
    await stopApp(h)
  }
})

test('allow rule allows immediately via rule', async () => {
  const h = await makeApp()
  try {
    h.rules.add('allow running commands matching ls *')
    const res = await h.approvals.authorize(shellAction({ target: 'ls -la' }), { mode: 'ask' })
    assert.equal(res.allowed, true)
    assert.equal(res.via, 'rule')
    assert.equal(h.approvals.pending().length, 0)
  } finally {
    await stopApp(h)
  }
})

test('trusted mode with no rules allows via rule', async () => {
  const h = await makeApp()
  try {
    const res = await h.approvals.authorize(shellAction(), { mode: 'trusted' })
    assert.equal(res.allowed, true)
    assert.equal(res.via, 'rule')
  } finally {
    await stopApp(h)
  }
})

test('ask mode with no matching rule enqueues a pending request', async () => {
  const h = await makeApp()
  try {
    const requested = collectEvents<ApprovalRequest>(h, 'whales/approval-requested')
    const action = shellAction()
    const p = h.approvals.authorize(action, { mode: 'ask' })
    const raced = await racePending(p)
    assert.equal(raced, 'pending')

    const pending = h.approvals.pending()
    assert.equal(pending.length, 1)
    const req = pending[0]
    assert.ok(req)
    assert.equal(req.status, 'pending')
    assert.match(req.id, /^appr_/)
    assert.equal(req.scope, 'agent:a1')
    assert.deepEqual(req.action, action)
    assert.equal(typeof req.reason, 'string')
    assert.ok(req.reason.length > 0)

    assert.equal(requested.length, 1)
    assert.equal(requested[0]?.id, req.id)

    const stored = h.app.ctx.get('store')
    assert.ok(stored)
    const rec = stored.collection('approvals').get(req.id)
    assert.ok(rec)
    assert.equal(rec.status, 'pending')

    assert.equal(h.approvals.answer(req.id, 'allow-once'), true)
    const settled = await p
    assert.equal(settled.allowed, true)
  } finally {
    await stopApp(h)
  }
})

test('allow-once resolves via user and does not persist a rule', async () => {
  const h = await makeApp()
  try {
    const resolved = collectEvents<ApprovalRequest>(h, 'whales/approval-resolved')
    const action = shellAction()
    const p = h.approvals.authorize(action, { mode: 'ask' })
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.equal(h.approvals.answer(req.id, 'allow-once'), true)
    const res = await p
    assert.equal(res.allowed, true)
    assert.equal(res.via, 'user')
    assert.equal(res.requestId, req.id)

    const rec = h.approvals.get(req.id)
    assert.ok(rec)
    assert.equal(rec.status, 'allowed')
    assert.equal(rec.decision, 'allow-once')
    assert.equal(typeof rec.decidedAt, 'number')

    assert.equal(resolved.length, 1)
    assert.equal(resolved[0]?.id, req.id)
    assert.equal(h.approvals.pending().length, 0)
    assert.equal(h.approvals.answer(req.id, 'allow-once'), false)

    // second identical action asks again
    const p2 = h.approvals.authorize(action, { mode: 'ask' })
    const raced = await racePending(p2)
    assert.equal(raced, 'pending')
    const req2 = h.approvals.pending()[0]
    assert.ok(req2)
    assert.equal(h.approvals.answer(req2.id, 'deny'), true)
    await p2
  } finally {
    await stopApp(h)
  }
})

test('deny decision stores note and resolves via user', async () => {
  const h = await makeApp()
  try {
    const p = h.approvals.authorize(shellAction(), { mode: 'ask' })
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.equal(h.approvals.answer(req.id, 'deny', 'no thanks'), true)
    const res = await p
    assert.equal(res.allowed, false)
    assert.equal(res.via, 'user')
    const rec = h.approvals.get(req.id)
    assert.ok(rec)
    assert.equal(rec.status, 'denied')
    assert.equal(rec.note, 'no thanks')
  } finally {
    await stopApp(h)
  }
})

test('allow-always adds an agent-scoped rule for exactly this kind and target', async () => {
  const h = await makeApp()
  try {
    const action = shellAction()
    const p = h.approvals.authorize(action, { mode: 'ask' })
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.equal(h.approvals.answer(req.id, 'allow-always'), true)
    const res = await p
    assert.equal(res.allowed, true)

    const scoped = h.rules.list('agent:a1')
    const added = scoped.filter((r: Rule) => r.scope === 'agent:a1')
    assert.ok(added.length >= 1)

    // same action for a1 allowed via rule, no ask
    const again = await h.approvals.authorize(action, { mode: 'ask' })
    assert.equal(again.allowed, true)
    assert.equal(again.via, 'rule')
    assert.equal(h.approvals.pending().length, 0)

    // same action for a2 still asks
    const p2 = h.approvals.authorize(shellAction({ agentId: 'a2' }), { mode: 'ask' })
    const raced = await racePending(p2)
    assert.equal(raced, 'pending')
    const req2 = h.approvals.pending()[0]
    assert.ok(req2)
    assert.equal(h.approvals.answer(req2.id, 'deny'), true)
    await p2

    // different target for a1 still asks
    const p3 = h.approvals.authorize(shellAction({ target: 'pwd' }), { mode: 'ask' })
    const raced3 = await racePending(p3)
    assert.equal(raced3, 'pending')
    const req3 = h.approvals.pending()[0]
    assert.ok(req3)
    assert.equal(h.approvals.answer(req3.id, 'deny'), true)
    await p3
  } finally {
    await stopApp(h)
  }
})

test('allow-always on a glob target does not allow command injection', async () => {
  const h = await makeApp()
  try {
    const action = shellAction({ target: 'ls *.ts' })
    const p = h.approvals.authorize(action, { mode: 'ask' })
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.equal(h.approvals.answer(req.id, 'allow-always'), true)
    await p

    const injected = h.approvals.authorize(shellAction({ target: 'ls; rm -rf x' }), { mode: 'ask' })
    const raced = await racePending(injected)
    assert.equal(raced, 'pending')
    const req2 = h.approvals.pending()[0]
    assert.ok(req2)
    assert.equal(h.approvals.answer(req2.id, 'deny'), true)
    await injected
  } finally {
    await stopApp(h)
  }
})

test('room actions downgrade allow to ask', async () => {
  const h = await makeApp()
  try {
    h.rules.add('allow running commands matching ls *')
    const p = h.approvals.authorize(shellAction({ roomId: 'r1' }), { mode: 'ask' })
    const raced = await racePending(p)
    assert.equal(raced, 'pending')
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.equal(h.approvals.answer(req.id, 'deny'), true)
    await p
  } finally {
    await stopApp(h)
  }
})

test('strict mode ignores allow rules', async () => {
  const h = await makeApp()
  try {
    h.rules.add('allow running commands matching ls *')
    const p = h.approvals.authorize(shellAction(), { mode: 'strict' })
    const raced = await racePending(p)
    assert.equal(raced, 'pending')
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.equal(h.approvals.answer(req.id, 'deny'), true)
    await p
  } finally {
    await stopApp(h)
  }
})

test('unknown id returns false and invalid decision throws', async () => {
  const h = await makeApp()
  try {
    assert.equal(h.approvals.answer('appr_nope', 'allow-once'), false)
    const p = h.approvals.authorize(shellAction(), { mode: 'ask' })
    const req = h.approvals.pending()[0]
    assert.ok(req)
    assert.throws(() => {
      h.approvals.answer(req.id, 'maybe' as never)
    }, TypeError)
    assert.equal(h.approvals.answer(req.id, 'deny'), true)
    await p
  } finally {
    await stopApp(h)
  }
})

test('aborting a pending request cancels it', async () => {
  const h = await makeApp()
  try {
    const ac = new AbortController()
    const p = h.approvals.authorize(shellAction(), { mode: 'ask', signal: ac.signal })
    const req = h.approvals.pending()[0]
    assert.ok(req)
    ac.abort()
    const res = await p
    assert.equal(res.allowed, false)
    assert.equal(res.via, 'cancelled')
    const rec = h.approvals.get(req.id)
    assert.ok(rec)
    assert.equal(rec.status, 'cancelled')
    assert.equal(h.approvals.pending().length, 0)
    assert.equal(h.approvals.answer(req.id, 'allow-once'), false)
  } finally {
    await stopApp(h)
  }
})

test('pre-aborted signal never creates a request', async () => {
  const h = await makeApp()
  try {
    const ac = new AbortController()
    ac.abort()
    const res = await h.approvals.authorize(shellAction(), { mode: 'ask', signal: ac.signal })
    assert.equal(res.allowed, false)
    assert.equal(h.approvals.pending().length, 0)
  } finally {
    await stopApp(h)
  }
})

test('invalid actions are never allowed and never throw', async () => {
  const h = await makeApp()
  try {
    const cases: Array<{ action: Action; mode: PermissionMode }> = [
      { action: shellAction({ kind: 'teleport' as never }), mode: 'trusted' },
      { action: shellAction({ agentId: 'Bad Id' }), mode: 'trusted' },
      { action: shellAction({ target: '' }), mode: 'trusted' },
      { action: shellAction({ target: 'x'.repeat(4001) }), mode: 'trusted' },
      { action: shellAction({ summary: 'x'.repeat(501) }), mode: 'trusted' },
      { action: shellAction(), mode: 'yolo' as never },
    ]
    for (const c of cases) {
      const res = await h.approvals.authorize(c.action, { mode: c.mode })
      assert.equal(res.allowed, false)
    }
    assert.equal(h.approvals.pending().length, 0)
  } finally {
    await stopApp(h)
  }
})

test('file actions escaping the workdir are not auto-allowed', async () => {
  const h = await makeApp()
  try {
    h.rules.add('allow reading files')
    const p1 = h.approvals.authorize(
      { kind: 'file.read', target: '../x', agentId: 'a1', summary: 'read ../x' },
      { mode: 'trusted' },
    )
    const raced1 = await racePending(p1)
    assert.equal(raced1, 'pending')
    const req1 = h.approvals.pending()[0]
    assert.ok(req1)
    assert.equal(h.approvals.answer(req1.id, 'deny'), true)
    await p1

    const p2 = h.approvals.authorize(
      { kind: 'file.read', target: '/etc/passwd', agentId: 'a1', summary: 'read /etc/passwd' },
      { mode: 'trusted' },
    )
    const raced2 = await racePending(p2)
    assert.equal(raced2, 'pending')
    const req2 = h.approvals.pending()[0]
    assert.ok(req2)
    assert.equal(h.approvals.answer(req2.id, 'deny'), true)
    await p2

    h.rules.add('deny reading files matching /etc/**')
    const denied = await h.approvals.authorize(
      { kind: 'file.read', target: '/etc/passwd', agentId: 'a1', summary: 'read /etc/passwd' },
      { mode: 'trusted' },
    )
    assert.equal(denied.allowed, false)
    assert.equal(denied.via, 'rule')
  } finally {
    await stopApp(h)
  }
})

test('concurrent requests answered in reverse order resolve independently', async () => {
  const h = await makeApp()
  try {
    const p1 = h.approvals.authorize(shellAction({ target: 'ls -la' }), { mode: 'ask' })
    const p2 = h.approvals.authorize(shellAction({ target: 'pwd' }), { mode: 'ask' })
    const pending = h.approvals.pending()
    assert.equal(pending.length, 2)
    const first = pending[0]
    const second = pending[1]
    assert.ok(first)
    assert.ok(second)

    assert.equal(h.approvals.answer(second.id, 'deny'), true)
    assert.equal(h.approvals.answer(first.id, 'allow-once'), true)

    const r2 = await p2
    const r1 = await p1
    assert.equal(r2.allowed, false)
    assert.equal(r2.requestId, second.id)
    assert.equal(r1.allowed, true)
    assert.equal(r1.requestId, first.id)
  } finally {
    await stopApp(h)
  }
})

test('disposal cancels a pending request', async () => {
  const h = await makeApp()
  try {
    const p = h.approvals.authorize(shellAction(), { mode: 'ask' })
    const raced = await racePending(p)
    assert.equal(raced, 'pending')
    await h.app.stop()
    const res = await p
    assert.equal(res.allowed, false)
    assert.equal(res.via, 'cancelled')
  } finally {
    await rm(h.tmp, { recursive: true, force: true })
  }
})

test('restart expires or cancels a persisted pending request', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'whales-appr-restart-'))
  const storePath = path.join(tmp, 'w.db')
  let oldId = ''
  try {
    const h1 = await makeApp(storePath)
    const p = h1.approvals.authorize(shellAction(), { mode: 'ask' })
    const raced = await racePending(p)
    assert.equal(raced, 'pending')
    const req = h1.approvals.pending()[0]
    assert.ok(req)
    oldId = req.id
    await h1.app.stop()
    const res = await p
    assert.equal(res.allowed, false)
    await rm(h1.tmp, { recursive: true, force: true })

    const h2 = await makeApp(storePath)
    try {
      const rec = h2.approvals.get(oldId)
      assert.ok(rec)
      assert.notEqual(rec.status, 'pending')
      assert.ok(rec.status === 'expired' || rec.status === 'cancelled')
      assert.equal(h2.approvals.pending().length, 0)
      assert.equal(h2.approvals.answer(oldId, 'allow-once'), false)
    } finally {
      await stopApp(h2)
    }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})

test('crash recovery: a pending record with no live waiter is expired on startup', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'whales-appr-crash-'))
  const file = path.join(dir, 'w.db')
  try {
    // Simulate a crash: the record is written as pending but no process is waiting for it.
    const first = await makeApp(file)
    first.app.ctx.store.collection('approvals').put({
      id: 'appr_crashed',
      scope: 'agent:a1',
      createdAt: Date.now(),
      action: shellAction(),
      reason: 'no rule matched',
      status: 'pending',
    })
    await stopApp(first)
    const second = await makeApp(file)
    try {
      assert.equal(second.app.ctx.store.collection('approvals').get('appr_crashed')?.status, 'expired')
      assert.equal(second.app.ctx.get('approvals')?.answer('appr_crashed', 'allow-once'), false)
    } finally {
      await stopApp(second)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
