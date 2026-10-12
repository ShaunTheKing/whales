#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

// Node 22 flags node:sqlite as experimental and would print that on every command. Hide only that warning;
// everything else still goes to stderr. Installed before the app (and node:sqlite) is loaded below.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
  process.stderr.write(`${warning.name}: ${warning.message}\n`)
})

const envFile = path.join(process.cwd(), '.env')
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

const { run } = await import('./run.ts')
process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
})
