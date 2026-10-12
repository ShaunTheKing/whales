#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { run } from './run.ts'

const envFile = path.join(process.cwd(), '.env')
if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
})
