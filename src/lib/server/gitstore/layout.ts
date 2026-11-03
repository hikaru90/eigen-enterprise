/**
 * The company data repo layout contract (v1, plan/phase-git-native.md §2).
 * Every surface owns one top-level prefix; nothing writes outside its prefix.
 * Paths are POSIX, relative to the repo root, and never escape it.
 */

export const LAYOUT = {
  /** Pins the running system (core, extensions, apps) — see system.ts. */
  system: 'system.yaml',
  company: 'company.md',
  settings: 'settings/',
  members: 'members/',
  groups: 'groups/',
  access: 'access/',
  drive: 'drive/',
  messages: 'messages/',
  memory: 'memory/',
  roadmap: 'roadmap/',
  brand: 'brand/',
  website: 'website/',
  agent: 'agent/',
  secrets: 'secrets/',
  keys: '.keys/',
  /** Reserved: each extension's own data folder, `extensions/<id>/…` (plan/phase-extensions.md). */
  extensions: 'extensions/',
} as const

export function extensionDataPrefix(extensionId: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(extensionId))
    throw new LayoutError(`invalid extension id "${extensionId}"`)
  return `${LAYOUT.extensions}${extensionId}/`
}

export type LayoutArea = keyof typeof LAYOUT

/** Encrypted files carry this suffix and are standard age files. */
export const ENCRYPTED_SUFFIX = '.age'

const SEGMENT = /^[A-Za-z0-9._@+-][A-Za-z0-9._@+ -]*$/

export class LayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LayoutError'
  }
}

/** Refuse anything that could escape the repo or hide in git internals. */
export function assertRepoPath(path: string): string {
  if (path.length === 0 || path.startsWith('/') || path.endsWith('/'))
    throw new LayoutError(`not a repo file path: "${path}"`)
  for (const seg of path.split('/')) {
    if (seg === '.' || seg === '..' || seg === '.git' || !SEGMENT.test(seg)) {
      throw new LayoutError(`unsafe path segment "${seg}" in "${path}"`)
    }
  }
  return path
}

/**
 * A file-name slug: lowercase ASCII letters/digits joined by single dashes,
 * at most 60 chars. Empty input → "untitled". Deterministic.
 */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return s.length > 0 ? s : 'untitled'
}

export function underPrefix(path: string, prefix: string): boolean {
  return path.startsWith(prefix)
}

export function secretPath(scope: string, name: string): string {
  return assertRepoPath(`${LAYOUT.secrets}${scope}/${name}${ENCRYPTED_SUFFIX}`)
}
