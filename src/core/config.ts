import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { PermissionMode, PluginRef } from '../contracts/core.ts'
import type { WhalesConfig } from '../contracts/config.ts'

export class ConfigError extends Error {
  override name = 'ConfigError'
}

export interface ConfigSources {
  env?: Record<string, string | undefined>
  home?: string
  cwd?: string
}

const CONFIG_FILE = 'whales.config.json'
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'strict', 'trusted']
const SECRET_KEY_RE = /key|token|secret|password/i

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail(problem: string): never {
  throw new ConfigError(`${CONFIG_FILE}: ${problem}`)
}

function failAt(dotted: string, problem: string): never {
  fail(`${dotted}: ${problem}`)
}

/** Build the default configuration, resolving `dataDir` from the given sources. */
export function defaultConfig(src?: ConfigSources): WhalesConfig {
  const env = src?.env ?? process.env
  const home = src?.home ?? os.homedir()
  const cwd = src?.cwd ?? process.cwd()

  const fromEnv = env.WHALES_DATA_DIR
  const dataDir = fromEnv ? path.resolve(cwd, fromEnv) : path.join(home, '.whales')

  return {
    dataDir,
    server: {
      host: '127.0.0.1',
      port: 7777,
      tokenEnv: 'WHALES_API_TOKEN',
    },
    defaults: {
      permissionMode: 'ask',
      cheapDriver: {
        name: 'driver-openai-compat',
        config: { preset: 'deepseek', model: 'deepseek-chat' },
      },
    },
  }
}

function validateRaw(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    fail('top level must be a JSON object')
  }
  if ('dataDir' in raw) {
    failAt('dataDir', 'must not be set in the config file')
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'server' && key !== 'defaults') {
      failAt(key, 'unknown key')
    }
  }
  if ('server' in raw) {
    const server = raw.server
    if (!isPlainObject(server)) {
      failAt('server', 'must be an object')
    }
    for (const key of Object.keys(server)) {
      if (key !== 'host' && key !== 'port' && key !== 'tokenEnv') {
        failAt(`server.${key}`, 'unknown key')
      }
    }
  }
  if ('defaults' in raw) {
    const defaults = raw.defaults
    if (!isPlainObject(defaults)) {
      failAt('defaults', 'must be an object')
    }
    for (const key of Object.keys(defaults)) {
      if (key !== 'permissionMode' && key !== 'cheapDriver') {
        failAt(`defaults.${key}`, 'unknown key')
      }
    }
  }
  return raw
}

function mergeConfig(base: WhalesConfig, raw: Record<string, unknown>): WhalesConfig {
  const merged: WhalesConfig = {
    dataDir: base.dataDir,
    server: { ...base.server },
    defaults: {
      permissionMode: base.defaults.permissionMode,
      cheapDriver: { ...base.defaults.cheapDriver },
    },
  }

  const server = raw.server
  if (isPlainObject(server)) {
    if ('host' in server) merged.server.host = server.host as string
    if ('port' in server) merged.server.port = server.port as number
    if ('tokenEnv' in server) merged.server.tokenEnv = server.tokenEnv as string
  }

  const defaults = raw.defaults
  if (isPlainObject(defaults)) {
    if ('permissionMode' in defaults) {
      merged.defaults.permissionMode = defaults.permissionMode as PermissionMode
    }
    if ('cheapDriver' in defaults) {
      merged.defaults.cheapDriver = defaults.cheapDriver as PluginRef
    }
  }

  return merged
}

function validateMerged(cfg: WhalesConfig): void {
  const { server, defaults } = cfg

  if (typeof server.host !== 'string' || server.host.length === 0) {
    failAt('server.host', 'must be a non-empty string')
  }
  if (
    typeof server.port !== 'number' ||
    !Number.isInteger(server.port) ||
    server.port < 1 ||
    server.port > 65535
  ) {
    failAt('server.port', 'must be an integer between 1 and 65535')
  }
  if (server.tokenEnv !== undefined && typeof server.tokenEnv !== 'string') {
    failAt('server.tokenEnv', 'must be a string')
  }
  if (!PERMISSION_MODES.includes(defaults.permissionMode)) {
    failAt('defaults.permissionMode', 'must be one of ask, strict, trusted')
  }

  const driver = defaults.cheapDriver
  if (!isPlainObject(driver)) {
    failAt('defaults.cheapDriver', 'must be an object')
  }
  if (typeof driver.name !== 'string' || driver.name.length === 0) {
    failAt('defaults.cheapDriver', 'must have a non-empty string name')
  }
  if (driver.config !== undefined && !isPlainObject(driver.config)) {
    failAt('defaults.cheapDriver', 'config must be an object')
  }

  if (!LOCAL_HOSTS.has(server.host)) {
    if (typeof server.tokenEnv !== 'string' || server.tokenEnv.length === 0) {
      failAt('server.tokenEnv', 'is required when server.host is not local')
    }
  }
}

function scanSecrets(value: unknown, dotted: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanSecrets(item, `${dotted}[${i}]`))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    const childPath = dotted ? `${dotted}.${key}` : key
    if (typeof child === 'string' && SECRET_KEY_RE.test(key) && !key.endsWith('Env')) {
      failAt(childPath, 'looks like a secret; use an *Env key instead')
    }
    scanSecrets(child, childPath)
  }
}

/** Load `whales.config.json` from the resolved data dir, merged over defaults. */
export async function loadConfig(src?: ConfigSources): Promise<WhalesConfig> {
  const base = defaultConfig(src)
  const file = path.join(base.dataDir, CONFIG_FILE)

  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return base
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    fail(`invalid JSON: ${(err as Error).message}`)
  }

  const raw = validateRaw(parsed)
  const merged = mergeConfig(base, raw)
  validateMerged(merged)
  scanSecrets(merged, '')
  return merged
}
