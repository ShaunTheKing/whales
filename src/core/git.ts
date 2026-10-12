import { execFile } from 'node:child_process'
import os from 'node:os'

/**
 * SECURITY-CRITICAL (orchestrator-owned). The one way Whales runs git (checkpoints, marketplace installs).
 * execFile (no shell), a scrubbed environment (no inherited GIT_*, no global/system config), hooks and fsmonitor off,
 * so nothing in a work tree or a downloaded repository can make git execute code.
 */
export const GIT_OPTIONS = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.autocrlf=false',
  '-c', 'commit.gpgsign=false',
  '-c', 'gc.auto=0',
  '-c', 'advice.detachedHead=false',
]

export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'whales',
    GIT_AUTHOR_EMAIL: 'whales@localhost',
    GIT_COMMITTER_NAME: 'whales',
    GIT_COMMITTER_EMAIL: 'whales@localhost',
  }
  return { ...env, ...extra }
}

export function runGit(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=') && !a.includes('/')) ?? ''} failed: ${stderr.trim() || err.message}`))
      else resolve(stdout)
    })
  })
}
