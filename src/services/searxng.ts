import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

/**
 * SECURITY (orchestrator-owned). A SearXNG instance that Whales runs for the user in Docker, so free web search needs
 * no setup. Properties:
 *   - fixed image pinned by digest; fixed container name; docker run via execFile with fixed arguments (nothing from
 *     agents ever reaches these commands — the search query only goes to SearXNG over HTTP);
 *   - published on 127.0.0.1 only (never on the LAN), JSON output enabled, rate limiter off (single local user);
 *   - the container runs while Whales runs: started on demand, stopped when Whales stops.
 */

export const SEARXNG_IMAGE = 'searxng/searxng:2026.9.25-12f8b6515@sha256:5286edb35782454ab8a102c5eff6b54bff745853191b46aeead95f225aa6dfb6'
export const CONTAINER = 'whales-searxng'
const LABEL = 'com.whales.managed=searxng'
const DOCKER_CANDIDATES = [
  '/usr/local/bin/docker',
  '/opt/homebrew/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  path.join(os.homedir(), '.orbstack', 'bin', 'docker'),
  path.join(os.homedir(), '.docker', 'bin', 'docker'),
]
const DOCKER_DESKTOP_APP = '/Applications/Docker.app'

export type ManagedState = 'no-docker' | 'docker-stopped' | 'not-created' | 'stopped' | 'starting' | 'running' | 'error'

export interface ManagedStatus {
  state: ManagedState
  url?: string
  image: string
  detail?: string
}

export interface ManagedSearxngOptions {
  /** Folder for settings.yml (mounted into the container as /etc/searxng). */
  dir: string
  /** Tests: the docker program to run. */
  docker?: string
  /** Tests: choose the published port. */
  pickPort?: () => Promise<number>
  /** Tests: readiness probe. Default GET <url>/healthz. */
  probe?: (url: string) => Promise<boolean>
  /** Start Docker Desktop when its daemon is not running (default true on macOS). */
  launchDesktop?: boolean
  /** Waits, in ms (tests shorten them). */
  daemonWaitMs?: number
  readyWaitMs?: number
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function dockerEnv(dockerPath: string): NodeJS.ProcessEnv {
  // Docker's credential helpers live next to the CLI; keep the env minimal otherwise (no Whales keys).
  const env: NodeJS.ProcessEnv = {
    PATH: [path.dirname(dockerPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: os.homedir(),
    LANG: 'C',
  }
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'TMPDIR']) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function defaultProbe(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' })
    return res.ok
  } catch {
    return false
  }
}

export function settingsYaml(secret: string): string {
  return [
    '# Written by Whales. SearXNG for local agent web search (JSON output on, rate limiter off: one local user).',
    'use_default_settings: true',
    'general:',
    '  instance_name: "Whales search"',
    'server:',
    `  secret_key: "${secret}"`,
    '  limiter: false',
    '  image_proxy: false',
    '  public_instance: false',
    'search:',
    '  safe_search: 0',
    '  formats:',
    '    - html',
    '    - json',
    'ui:',
    '  static_use_hash: true',
    '',
  ].join('\n')
}

export class ManagedSearxng {
  private opts: ManagedSearxngOptions
  private ensuring: Promise<string> | undefined
  private lastError: string | undefined
  /** True once this process has started or confirmed the container; only then does stop() touch it. */
  private owned = false

  constructor(opts: ManagedSearxngOptions) {
    this.opts = opts
  }

  docker(): string | undefined {
    if (this.opts.docker) return this.opts.docker
    return DOCKER_CANDIDATES.find(isExecutable)
  }

  private run(args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const docker = this.docker()
    if (!docker) return Promise.resolve({ ok: false, stdout: '', stderr: 'docker not found' })
    return new Promise((resolve) => {
      execFile(docker, args, { env: dockerEnv(docker), timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout.trim(), stderr: stderr.trim() })
      })
    })
  }

  private async daemonUp(): Promise<boolean> {
    return (await this.run(['info', '--format', '{{.ServerVersion}}'], 10_000)).ok
  }

  private async inspect(): Promise<{ running: boolean; port: number | undefined; image: string } | undefined> {
    const r = await this.run(['inspect', '--format', '{{.State.Running}}|{{index .Config.Labels "com.whales.port"}}|{{.Config.Image}}', CONTAINER])
    if (!r.ok) return undefined
    const [running, port, image] = r.stdout.split('|')
    const parsed = Number(port)
    return { running: running === 'true', port: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined, image: image ?? '' }
  }

  async status(): Promise<ManagedStatus> {
    const base = { image: SEARXNG_IMAGE }
    if (!this.docker()) return { ...base, state: 'no-docker', detail: 'Install Docker Desktop (or OrbStack) to let Whales run SearXNG for you.' }
    if (this.ensuring) return { ...base, state: 'starting' }
    if (!(await this.daemonUp())) return { ...base, state: 'docker-stopped', detail: 'Docker is installed but not running; Whales starts it when search is needed.' }
    const info = await this.inspect()
    if (!info) return { ...base, state: this.lastError ? 'error' : 'not-created', ...(this.lastError ? { detail: this.lastError } : {}) }
    const url = info.port ? `http://127.0.0.1:${info.port}` : undefined
    return { ...base, state: info.running ? 'running' : 'stopped', ...(url ? { url } : {}) }
  }

  /** Make sure the container exists, runs and answers. Returns its URL. Concurrent callers share one attempt. */
  ensure(): Promise<string> {
    this.ensuring ??= this.doEnsure().then(
      (url) => {
        this.ensuring = undefined
        this.lastError = undefined
        this.owned = true
        return url
      },
      (err: unknown) => {
        this.ensuring = undefined
        this.lastError = err instanceof Error ? err.message : String(err)
        throw err
      },
    )
    return this.ensuring
  }

  private async doEnsure(): Promise<string> {
    if (!this.docker()) throw new Error('Docker is not installed. Install Docker Desktop (docker.com) or OrbStack, then try again.')
    if (!(await this.daemonUp())) {
      const canLaunch = (this.opts.launchDesktop ?? process.platform === 'darwin') && existsSync(DOCKER_DESKTOP_APP)
      if (!canLaunch) throw new Error('Docker is not running. Start Docker Desktop and try again.')
      // Opens Docker Desktop in the background (-g: does not steal focus).
      await new Promise<void>((resolve) => execFile('/usr/bin/open', ['-g', '-a', DOCKER_DESKTOP_APP], () => resolve()))
      const deadline = Date.now() + (this.opts.daemonWaitMs ?? 120_000)
      while (!(await this.daemonUp())) {
        if (Date.now() > deadline) throw new Error('Docker Desktop did not start in time. Open it once (it may ask to finish setup), then try again.')
        await sleep(2000)
      }
    }

    let info = await this.inspect()
    if (info && (info.image !== SEARXNG_IMAGE || !info.port)) {
      // An older Whales version or a hand-edited container: replace it.
      await this.run(['rm', '-f', CONTAINER])
      info = undefined
    }
    if (!info) {
      await mkdir(this.opts.dir, { recursive: true })
      const settings = path.join(this.opts.dir, 'settings.yml')
      if (!existsSync(settings)) await writeFile(settings, settingsYaml(randomBytes(32).toString('hex')), { mode: 0o644 })
      const port = await (this.opts.pickPort ?? freePort)()
      const created = await this.run(
        [
          'run', '-d',
          '--name', CONTAINER,
          '--label', LABEL,
          '--label', `com.whales.port=${port}`,
          '--restart', 'no',
          '-p', `127.0.0.1:${port}:8080`,
          '-v', `${this.opts.dir}:/etc/searxng`,
          '-e', `SEARXNG_BASE_URL=http://127.0.0.1:${port}/`,
          SEARXNG_IMAGE,
        ],
        // First run downloads the image (~100 MB).
        10 * 60_000,
      )
      if (!created.ok) throw new Error(`could not start SearXNG: ${created.stderr.slice(0, 300) || 'docker run failed'}`)
      info = { running: true, port, image: SEARXNG_IMAGE }
    } else if (!info.running) {
      const started = await this.run(['start', CONTAINER])
      if (!started.ok) throw new Error(`could not start SearXNG: ${started.stderr.slice(0, 300) || 'docker start failed'}`)
    }

    const url = `http://127.0.0.1:${info.port}`
    const probe = this.opts.probe ?? defaultProbe
    const deadline = Date.now() + (this.opts.readyWaitMs ?? 60_000)
    while (!(await probe(url))) {
      if (Date.now() > deadline) throw new Error('SearXNG started but did not become ready in time; see `docker logs whales-searxng`.')
      await sleep(1000)
    }
    return url
  }

  /** Stop the container (keeps it for a fast restart). Safe to call when nothing runs. */
  async stop(): Promise<void> {
    if (!this.owned || !this.docker()) return
    this.owned = false
    await this.run(['stop', '-t', '3', CONTAINER], 20_000)
  }

  /** Remove the container entirely (the image stays cached in Docker). */
  async remove(): Promise<void> {
    if (!this.docker()) return
    await this.run(['rm', '-f', CONTAINER], 20_000)
  }
}
