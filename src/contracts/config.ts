import type { PermissionMode, PluginRef } from './core.ts'

/** `whales.config.json` in the data dir, merged over defaults. Never contains secrets. */
export interface WhalesConfig {
  /** Absolute. Default `$WHALES_DATA_DIR` or `~/.whales`. */
  dataDir: string
  server: {
    /** Default `127.0.0.1`. Binding elsewhere requires `token`. */
    host: string
    port: number
    /** Name of the env var holding the API bearer token (not the token). */
    tokenEnv?: string
  }
  defaults: {
    permissionMode: PermissionMode
    /** Driver used for hired agents, e.g. `{ name: 'driver-openai-compat', config: { preset: 'deepseek' } }`. */
    cheapDriver: PluginRef
  }
}

declare module 'cordis' {
  interface Context {
    config: WhalesConfig
  }
}
