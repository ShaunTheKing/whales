import { spawn } from 'node:child_process'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Where model API keys live: the macOS Keychain, never the database, config,
 * logs or prompts.
 *
 * Uses Apple's `/usr/bin/security` tool:
 *   - write: `security -i` with the command on STDIN, so the key never appears in argv (visible to `ps`);
 *   - read:  `security find-generic-password -w` prints the key on stdout (argv holds only service + account);
 *   - delete: `security delete-generic-password`.
 * Items: service `whales.provider`, account = provider id, label `Whales: <name>`.
 * Keys are restricted to a quoting-safe character set so the interactive command line cannot be broken out of.
 */
export interface SecretStore {
  readonly kind: 'keychain' | 'memory'
  get(account: string): Promise<string | undefined>
  set(account: string, value: string, label: string): Promise<void>
  delete(account: string): Promise<void>
}

export const KEYCHAIN_SERVICE = 'whales.provider'
const SECURITY = '/usr/bin/security'
const ACCOUNT = /^[a-z][a-z0-9_-]{0,63}$/
/** Every real provider key we know of fits this (sk-…, sk-or-v1-…, base64/JWT-ish). No quotes, spaces or backslashes. */
export const API_KEY_FORMAT = /^[A-Za-z0-9._~+/=:-]{8,1024}$/
const LABEL = /^[\w .:()-]{1,80}$/
const TIMEOUT_MS = 15_000

export function assertApiKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !API_KEY_FORMAT.test(value)) {
    throw new TypeError('API key must be 8–1024 characters of letters, digits and . _ ~ + / = : -')
  }
}

function assertAccount(account: string): void {
  if (!ACCOUNT.test(account)) throw new TypeError('invalid keychain account')
}

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

function runSecurity(bin: string, args: string[], stdin?: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(stdin ?? '')
  })
}

export class MacKeychain implements SecretStore {
  readonly kind = 'keychain' as const
  private bin: string

  /** `bin` is for tests (a fake `security`); production always uses /usr/bin/security. */
  constructor(bin: string = SECURITY) {
    this.bin = bin
  }

  async get(account: string): Promise<string | undefined> {
    assertAccount(account)
    const r = await runSecurity(this.bin, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'])
    if (r.code === 44) return undefined
    if (r.code !== 0) throw new Error(`Keychain read failed (${r.code})`)
    const value = r.stdout.replace(/\n$/, '')
    return value.length ? value : undefined
  }

  async set(account: string, value: string, label: string): Promise<void> {
    assertAccount(account)
    assertApiKey(value)
    const safeLabel = LABEL.test(label) ? label : 'Whales provider'
    // -U updates an existing item. Every token is quoting-safe (validated above), so plain double quotes suffice.
    const command = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -l "${safeLabel}" -w "${value}"\n`
    const r = await runSecurity(this.bin, ['-i'], command)
    // Interactive mode reports failures on stderr but may still exit 0.
    if (r.code !== 0 || /error|failed|could not/i.test(r.stderr)) throw new Error('Keychain write failed')
    if ((await this.get(account)) !== value) throw new Error('Keychain write could not be verified')
  }

  async delete(account: string): Promise<void> {
    assertAccount(account)
    const r = await runSecurity(this.bin, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account])
    if (r.code !== 0 && r.code !== 44) throw new Error(`Keychain delete failed (${r.code})`)
  }
}

/** Tests and non-macOS development: keys live only in this process. */
export class MemorySecrets implements SecretStore {
  readonly kind = 'memory' as const
  private values = new Map<string, string>()

  async get(account: string): Promise<string | undefined> {
    return this.values.get(account)
  }

  async set(account: string, value: string): Promise<void> {
    assertAccount(account)
    assertApiKey(value)
    this.values.set(account, value)
  }

  async delete(account: string): Promise<void> {
    this.values.delete(account)
  }
}
