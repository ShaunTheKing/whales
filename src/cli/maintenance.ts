import path from 'node:path'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import type { WhalesConfig } from '../contracts/config.ts'
import { createBackup, readBackup, restoreBackup } from '../core/backup.ts'
import { errMessage, fail, usage, type Ctx, type CliIO, type LineReader } from './run.ts'

function parse(args: string[], options: NonNullable<ParseArgsConfig['options']>, command: string) {
  try {
    return parseArgs({ args, allowPositionals: true, strict: true, options })
  } catch (err) {
    usage(`${command}: ${errMessage(err)}`)
  }
}

/** `whales backup [--out <dir>]` */
export async function cmdBackup(ctx: Ctx, args: string[]): Promise<number> {
  const parsed = parse(args, { out: { type: 'string' } }, 'backup')
  const dataDir = ctx.app.ctx.config.dataDir
  const out = typeof parsed.values.out === 'string' ? path.resolve(ctx.io.cwd, parsed.values.out) : path.join(path.dirname(dataDir), 'whales-backups')
  const { dir, manifest } = await createBackup(ctx.app, out)
  ctx.io.stdout.write(`backup written to ${dir} (${manifest.files} files)\n`)
  return 0
}

/**
 * `whales restore <dir> [--force] [--yes]` — runs BEFORE the app opens the database (see run.ts), so it works on the
 * raw data dir. Never runs while `whales serve`/`daemon` use the same data dir.
 */
export async function cmdRestore(io: CliIO, lines: LineReader, config: WhalesConfig, args: string[]): Promise<number> {
  const parsed = parse(args, { force: { type: 'boolean' }, yes: { type: 'boolean' } }, 'restore')
  const source = parsed.positionals[0]
  if (!source) usage('restore: missing <backup dir>')
  const dir = path.resolve(io.cwd, source)
  const manifest = await readBackup(dir)
  io.stdout.write(`backup from ${manifest.createdAt}: database ${manifest.database.bytes} bytes, ${manifest.files} files (${manifest.directories.join(', ') || 'no directories'})\n`)
  if (parsed.values.yes !== true) {
    io.stderr.write(`restore into ${config.dataDir}? Make sure no whales server or daemon is running. [y/N] `)
    const answer = ((await lines.next()) ?? '').trim().toLowerCase()
    if (answer !== 'y' && answer !== 'yes') {
      io.stdout.write('cancelled\n')
      return 1
    }
  }
  try {
    await restoreBackup(dir, config.dataDir, { force: parsed.values.force === true })
  } catch (err) {
    fail(errMessage(err))
  }
  io.stdout.write(`restored ${manifest.files} files into ${config.dataDir}\n`)
  return 0
}

/** `whales checkpoints list|snapshot|diff|restore …` */
export async function cmdCheckpoints(ctx: Ctx, args: string[]): Promise<number> {
  const checkpoints = ctx.app.ctx.get('checkpoints')
  if (!checkpoints) fail('checkpoints service is not running')
  const [sub, ...rest] = args
  const parsed = parse(rest, { label: { type: 'string' }, to: { type: 'string' } }, `checkpoints ${sub ?? ''}`)
  const [target] = parsed.positionals
  if (!target) usage(`checkpoints ${sub ?? ''}: missing argument`)
  switch (sub) {
    case 'list': {
      const all = checkpoints.list(target)
      if (all.length === 0) ctx.io.stdout.write('no checkpoints\n')
      for (const c of all) ctx.io.stdout.write(`${c.id}\t${new Date(c.createdAt).toISOString()}\t${c.phase}\t${c.label}\n`)
      return 0
    }
    case 'snapshot': {
      const label = typeof parsed.values.label === 'string' ? parsed.values.label : 'manual snapshot'
      const c = await checkpoints.snapshot(target, label, 'manual')
      ctx.io.stdout.write(`snapshot ${c.id}\n`)
      return 0
    }
    case 'diff': {
      const to = typeof parsed.values.to === 'string' ? parsed.values.to : undefined
      const { changes, patch } = await checkpoints.diff(target, to)
      if (changes.length === 0) ctx.io.stdout.write('no changes\n')
      for (const change of changes) ctx.io.stdout.write(`${change.status.padEnd(8)} ${change.path}\n`)
      if (patch) ctx.io.stdout.write(`\n${patch}`)
      return 0
    }
    case 'restore': {
      // The approval prompt from run.ts asks before anything is touched; a safety snapshot is taken first.
      const safety = await checkpoints.restore(target)
      ctx.io.stdout.write(`restored; undo with: whales checkpoints restore ${safety.id}\n`)
      return 0
    }
    default:
      usage(`checkpoints: unknown subcommand ${sub ?? ''}`)
  }
}
