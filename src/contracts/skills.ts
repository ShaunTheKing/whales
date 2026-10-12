import type { BaseRecord } from './store.ts'

/**
 * A skill is a directory `<dataDir>/skills/<name>/SKILL.md` with YAML-ish front matter:
 *   ---
 *   name: code-review
 *   description: One line.
 *   ---
 *   markdown body…
 * Names match `^[a-z0-9][a-z0-9-]{0,63}$` (also prevents path traversal).
 */
export interface SkillMeta {
  name: string
  description: string
}

export interface Skill extends SkillMeta {
  body: string
  /** Absolute path of SKILL.md. */
  path: string
}

export interface SkillPreview extends SkillMeta {
  body: string
  /** Where it came from: absolute local path or https URL. */
  source: string
  /** sha256 of the exact SKILL.md bytes. `install` requires it, so nothing is installed unseen. */
  hash: string
  /** Installed skill with the same name, if any (install would replace it). */
  existing?: SkillMeta
}

/** Audit record of installs, scope `global`. */
export interface SkillInstallRecord extends BaseRecord {
  scope: 'global'
  name: string
  source: string
  hash: string
}

/** Root `skills` library service. Agents never install skills themselves. */
export interface SkillsService {
  list(): Promise<SkillMeta[]>
  read(name: string): Promise<Skill | undefined>
  /** Fetch/read and parse without writing anything. Max 256 KiB. */
  preview(source: string): Promise<SkillPreview>
  /** Installs the previewed content; re-fetches and rejects if the hash no longer matches. */
  install(source: string, hash: string): Promise<Skill>
  remove(name: string): Promise<boolean>
}

declare module './store.ts' {
  interface Collections {
    skillInstalls: SkillInstallRecord
  }
}

declare module 'cordis' {
  interface Context {
    skills: SkillsService
  }
}
