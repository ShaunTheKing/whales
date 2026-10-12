import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigError, defaultConfig, loadConfig } from '../../src/core/config.ts'
import type { ConfigSources } from '../../src/core/config.ts'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whales-test-'))
  tmpDirs.push(dir)
  return dir
}

function writeConfig(dataDir: string, contents: string): void {
  fs.writeFileSync(path.join(dataDir, 'whales.config.json'), contents, 'utf8')
}

function writeConfigJson(dataDir: string, value: unknown): void {
  writeConfig(dataDir, JSON.stringify(value))
}

/** A ConfigSources with an explicit dataDir via env, plus home/cwd. */
function src(dataDir: string, extra?: Partial<ConfigSources>): ConfigSources {
  return {
    env: { WHALES_DATA_DIR: dataDir },
    home: path.join(dataDir, 'home'),
    cwd: dataDir,
    ...extra,
  }
}

after(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('defaultConfig', () => {
  test('uses WHALES_DATA_DIR when set', () => {
    const dir = makeTmpDir()
    const cfg = defaultConfig(src(dir))
    assert.equal(cfg.dataDir, dir)
  })

  test('falls back to join(home, ".whales") when env is absent', () => {
    const home = makeTmpDir()
    const cfg = defaultConfig({ env: {}, home, cwd: home })
    assert.equal(cfg.dataDir, path.join(home, '.whales'))
  })

  test('resolves a relative WHALES_DATA_DIR against cwd', () => {
    const cwd = makeTmpDir()
    const cfg = defaultConfig({ env: { WHALES_DATA_DIR: 'rel/data' }, home: cwd, cwd })
    assert.equal(cfg.dataDir, path.join(cwd, 'rel', 'data'))
  })

  test('provides the documented server defaults', () => {
    const dir = makeTmpDir()
    const cfg = defaultConfig(src(dir))
    assert.equal(cfg.server.host, '127.0.0.1')
    assert.equal(cfg.server.port, 7777)
    assert.equal(cfg.server.tokenEnv, 'WHALES_API_TOKEN')
  })

  test('provides the documented defaults block', () => {
    const dir = makeTmpDir()
    const cfg = defaultConfig(src(dir))
    assert.equal(cfg.defaults.permissionMode, 'ask')
    assert.equal(cfg.defaults.cheapDriver.name, 'driver-openai-compat')
    assert.deepEqual(cfg.defaults.cheapDriver.config, {
      preset: 'deepseek',
      model: 'deepseek-chat',
    })
  })
})

describe('loadConfig', () => {
  test('missing file yields defaults', async () => {
    const dir = makeTmpDir()
    const cfg = await loadConfig(src(dir))
    assert.equal(cfg.dataDir, dir)
    assert.equal(cfg.server.port, 7777)
    assert.equal(cfg.defaults.permissionMode, 'ask')
  })

  test('valid partial file merges over defaults', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { server: { port: 8080 } })
    const cfg = await loadConfig(src(dir))
    assert.equal(cfg.server.port, 8080)
    assert.equal(cfg.server.host, '127.0.0.1')
    assert.equal(cfg.server.tokenEnv, 'WHALES_API_TOKEN')
    assert.equal(cfg.defaults.permissionMode, 'ask')
  })

  test('cheapDriver config is replaced as a whole object', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, {
      defaults: { cheapDriver: { name: 'driver-x', config: { preset: 'openai' } } },
    })
    const cfg = await loadConfig(src(dir))
    assert.equal(cfg.defaults.cheapDriver.name, 'driver-x')
    assert.deepEqual(cfg.defaults.cheapDriver.config, { preset: 'openai' })
  })

  test('cheapDriver without config is accepted', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { defaults: { cheapDriver: { name: 'driver-x' } } })
    const cfg = await loadConfig(src(dir))
    assert.equal(cfg.defaults.cheapDriver.name, 'driver-x')
  })

  test('arrays replace rather than merge', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { defaults: { cheapDriver: { name: 'driver-x', config: { list: [1, 2] } } } })
    const cfg = await loadConfig(src(dir))
    assert.deepEqual(cfg.defaults.cheapDriver.config, { list: [1, 2] })
  })

  test('non-local host with tokenEnv is accepted', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { server: { host: '0.0.0.0', tokenEnv: 'MY_TOKEN' } })
    const cfg = await loadConfig(src(dir))
    assert.equal(cfg.server.host, '0.0.0.0')
    assert.equal(cfg.server.tokenEnv, 'MY_TOKEN')
  })

  test('localhost and ::1 are accepted without tokenEnv', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { server: { host: 'localhost' } })
    const cfg = await loadConfig(src(dir))
    assert.equal(cfg.server.host, 'localhost')

    const dir2 = makeTmpDir()
    writeConfigJson(dir2, { server: { host: '::1' } })
    const cfg2 = await loadConfig(src(dir2))
    assert.equal(cfg2.server.host, '::1')
  })

  test('secret-like key with string value is rejected', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { defaults: { cheapDriver: { name: 'd', config: { apiKey: 'sk-123' } } } })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /apiKey/)
      return true
    })
  })

  test('secret-like key ending in Env is accepted', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, {
      defaults: { cheapDriver: { name: 'd', config: { apiKeyEnv: 'DEEPSEEK_API_KEY' } } },
    })
    const cfg = await loadConfig(src(dir))
    assert.deepEqual(cfg.defaults.cheapDriver.config, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
  })

  test('invalid JSON throws ConfigError', async () => {
    const dir = makeTmpDir()
    writeConfig(dir, '{ not json')
    await assert.rejects(loadConfig(src(dir)), ConfigError)
  })

  test('non-object top level throws ConfigError', async () => {
    const dir = makeTmpDir()
    writeConfig(dir, '[1, 2, 3]')
    await assert.rejects(loadConfig(src(dir)), ConfigError)

    const dir2 = makeTmpDir()
    writeConfig(dir2, '"hello"')
    await assert.rejects(loadConfig(src(dir2)), ConfigError)
  })

  test('dataDir in file throws ConfigError', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { dataDir: '/somewhere/else' })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /dataDir/)
      return true
    })
  })

  test('unknown top-level key throws ConfigError', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { nope: 1 })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /nope/)
      return true
    })
  })

  test('unknown server key throws ConfigError naming the path', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { server: { bogus: 1 } })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /server\.bogus/)
      return true
    })
  })

  test('unknown defaults key throws ConfigError naming the path', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { defaults: { bogus: 1 } })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /defaults\.bogus/)
      return true
    })
  })

  test('server.port out of range throws ConfigError naming server.port', async () => {
    for (const port of [0, -1, 65536, 1.5, '8080']) {
      const dir = makeTmpDir()
      writeConfigJson(dir, { server: { port } })
      await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /server\.port/)
        return true
      })
    }
  })

  test('server.host non-string or empty throws ConfigError naming server.host', async () => {
    for (const host of ['', 5, null]) {
      const dir = makeTmpDir()
      writeConfigJson(dir, { server: { host } })
      await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /server\.host/)
        return true
      })
    }
  })

  test('invalid permissionMode throws ConfigError naming defaults.permissionMode', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { defaults: { permissionMode: 'yolo' } })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /defaults\.permissionMode/)
      return true
    })
  })

  test('invalid cheapDriver throws ConfigError naming defaults.cheapDriver', async () => {
    for (const cheapDriver of [{}, { name: '' }, { name: 5 }, 'driver-x']) {
      const dir = makeTmpDir()
      writeConfigJson(dir, { defaults: { cheapDriver } })
      await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
        assert.ok(err instanceof ConfigError)
        assert.match(err.message, /defaults\.cheapDriver/)
        return true
      })
    }
  })

  test('non-local host with empty tokenEnv throws ConfigError', async () => {
    const dir = makeTmpDir()
    writeConfigJson(dir, { server: { host: '0.0.0.0', tokenEnv: '' } })
    await assert.rejects(loadConfig(src(dir)), (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      assert.match(err.message, /server\.tokenEnv/)
      return true
    })
  })
})
