import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, Menu, Notification, app, dialog, session, shell, type WebContents } from 'electron'
import { createApp, type App } from '../core/app.ts'
import { loadConfig } from '../core/config.ts'
import { startServer, type RunningServer } from '../server/server.ts'
import type {} from '../contracts/index.ts'

/**
 * SECURITY-CRITICAL (orchestrator-owned). Whales desktop shell.
 *
 * The main process runs the same app + HTTP/WebSocket server as `whales serve`, bound to 127.0.0.1 on a random port
 * with a fresh random token per launch (never WHALES_API_TOKEN, never written anywhere). The window loads the existing
 * web UI from that server, token in the URL fragment as usual. The renderer is an ordinary sandboxed web page:
 *   - contextIsolation + sandbox, no nodeIntegration, no preload: the page has no Node or Electron APIs;
 *   - navigation is pinned to the server origin; http(s) links open in the system browser, everything else is denied;
 *   - new windows, webviews and every permission request (camera, notifications, …) are denied.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

let whales: App | undefined
let server: RunningServer | undefined
let window: BrowserWindow | undefined
let quitting = false

/** Keys for model APIs: `<dataDir>/.env` (works for Finder launches), then `./.env` (dev runs from the repo). */
function loadEnvFiles(dataDir: string): void {
  for (const file of [path.join(dataDir, '.env'), path.join(process.cwd(), '.env')]) {
    if (existsSync(file)) process.loadEnvFile(file)
  }
}

function webDist(): string | undefined {
  for (const candidate of [path.join(here, '../../web/dist'), path.join(app.getAppPath(), 'web/dist')]) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate
  }
  return undefined
}

function lockDown(contents: WebContents, origin: string): void {
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) {
      event.preventDefault()
      openExternal(url)
    }
  })
  contents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
}

function openExternal(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.href)
  } catch {
    // not a URL: ignore
  }
}

async function start(): Promise<void> {
  const config = await loadConfig({ env: process.env, cwd: process.cwd() })
  await mkdir(config.dataDir, { recursive: true })
  loadEnvFiles(config.dataDir)

  whales = await createApp({ config, storePath: path.join(config.dataDir, 'whales.db') })
  const restored = await whales.ctx.agents.restore()
  for (const failure of restored.failed) console.error(`failed to start agent ${failure.id}: ${failure.error}`)

  const staticDir = webDist()
  if (!staticDir) throw new Error('web UI is not built (run: pnpm build)')
  // `env: {}` forces a generated token: the desktop app never reuses or exposes a long-lived one.
  server = await startServer(whales, { host: '127.0.0.1', port: 0, env: {}, staticDir })
  const origin = new URL(server.url).origin

  // Approvals are the moment the user is needed: raise a native notification when the window is not focused.
  whales.ctx.on('whales/approval-requested', (request) => {
    if (window?.isFocused() || !Notification.isSupported()) return
    const note = new Notification({ title: 'Whales needs your approval', body: request.action.summary.slice(0, 200) })
    note.on('click', () => window?.show())
    note.show()
  })

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  app.on('web-contents-created', (_event, contents) => lockDown(contents, origin))

  createWindow()
}

function createWindow(): void {
  if (!server) return
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: 'Whales',
    backgroundColor: '#f8f7f4',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: true,
    },
  })
  window.once('ready-to-show', () => window?.show())
  if (process.env.WHALES_DESKTOP_SMOKE === '1') smokeTest(window)
  window.on('closed', () => {
    window = undefined
  })
  void window.loadURL(server.uiUrl)
}

/** CI/dev check: wait for the UI to render signed in, print a one-line report, quit. Never prints the token. */
function smokeTest(win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void win.webContents
        .executeJavaScript(
          `JSON.stringify({ sidebar: !!document.querySelector('.sidebar'), tokenGate: !!document.querySelector('input[type=password]'), shell: document.documentElement.dataset.shell ?? null, tokenInUrl: location.href.includes('token='), agents: document.querySelectorAll('.sidebar .nav-item').length })`,
        )
        .then((report: string) => console.log(`WHALES_SMOKE ${report}`))
        .finally(() => app.quit())
    }, 1500)
  })
}

async function shutdown(): Promise<void> {
  const running = server
  const appInstance = whales
  server = undefined
  whales = undefined
  await running?.close().catch(() => {})
  await appInstance?.stop().catch(() => {})
}

// One instance per data dir: two processes must not share the SQLite database. Electron's lock lives in userData,
// so a custom WHALES_DATA_DIR gets its own userData (and therefore its own lock).
if (process.env.WHALES_DATA_DIR && path.isAbsolute(process.env.WHALES_DATA_DIR)) {
  app.setPath('userData', path.join(process.env.WHALES_DATA_DIR, 'desktop'))
}
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!window) createWindow()
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (!window) createWindow()
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void shutdown().finally(() => app.quit())
  })

  app.whenReady().then(
    async () => {
      if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate(macMenu()))
      try {
        await start()
      } catch (err) {
        dialog.showErrorBox('Whales could not start', err instanceof Error ? err.message : String(err))
        quitting = true
        await shutdown()
        app.quit()
      }
    },
    () => app.quit(),
  )
}

function macMenu(): Electron.MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
  ]
}
