import { z } from 'zod'
import { canonicalYaml, parseYaml } from './canonical'
import { LAYOUT } from './layout'

/**
 * `system.yaml` at the data repo root (plan/phase-git-native.md §8,
 * plan/phase-upgrades-u2.md §3): pins exactly what runs — the core release +
 * commit, every company module (id, version, commit, bundleSha256) and every
 * installed app (name + source commit). A restore reads it and installs
 * exactly that before rebuilding the index. Every change is a commit authored
 * by the person who deployed/updated.
 *
 * v2 (U2): `modules` replaces `extensions` and pins each module's bundle; the
 * `core` pin is written by the installer and may be absent until it is (the
 * kernel pins its modules without inventing a core commit). A v1 file still
 * reads: its `extensions` become `modules` without a bundle (null).
 */

export const SYSTEM_PATH = LAYOUT.system
export const SYSTEM_FORMAT = 'eigen.system'
export const SYSTEM_VERSION = 2

const commit = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character git commit hash')
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'a semver version')
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a sha256 (64 lowercase hex)')
const id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/)
const core = z.object({ release: semver, commit }).strict()
const apps = z
  .array(
    z
      .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
        source: z.string().min(1),
        commit,
      })
      .strict(),
  )
  .default([])

/** v1 (read only). */
const systemV1Schema = z
  .object({
    format: z.literal(SYSTEM_FORMAT),
    version: z.literal(1),
    core,
    extensions: z.array(z.object({ id, version: semver, commit }).strict()).default([]),
    apps,
  })
  .strict()

export const systemSchema = z
  .object({
    format: z.literal(SYSTEM_FORMAT),
    version: z.literal(SYSTEM_VERSION),
    core: core.optional(),
    modules: z.array(z.object({ id, version: semver, commit, bundleSha256: sha256 }).strict()).default([]),
    apps,
  })
  .strict()

export type SystemModule = { id: string; version: string; commit: string; bundleSha256: string | null }
export type SystemPin = {
  core?: { release: string; commit: string }
  /** v1 extensions read as modules with bundleSha256 null. */
  modules: SystemModule[]
  apps: { name: string; source: string; commit: string }[]
}

export class SystemFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SystemFileError'
  }
}

function problem(r: z.ZodSafeParseError<unknown>): never {
  const i = r.error.issues[0]
  throw new SystemFileError(`${SYSTEM_PATH}: ${i?.path.join('.') || 'file'}: ${i?.message ?? 'invalid'}`)
}

function unique(pin: SystemPin): SystemPin {
  const mods = pin.modules.map((e) => e.id)
  if (new Set(mods).size !== mods.length) throw new SystemFileError(`${SYSTEM_PATH}: a module is listed twice`)
  const names = pin.apps.map((a) => a.name)
  if (new Set(names).size !== names.length) throw new SystemFileError(`${SYSTEM_PATH}: an app is listed twice`)
  return pin
}

function check(value: unknown): SystemPin {
  const header = value as { format?: unknown; version?: unknown } | null
  if (header && header.format === SYSTEM_FORMAT && typeof header.version === 'number' && header.version > SYSTEM_VERSION) {
    throw new SystemFileError(
      `${SYSTEM_PATH} is ${SYSTEM_FORMAT} v${header.version}; this code reads v${SYSTEM_VERSION} — restore with a newer installer`,
    )
  }
  if (header && header.version === 1) {
    const r = systemV1Schema.safeParse(value)
    if (!r.success) problem(r)
    if (new Set(r.data.extensions.map((e) => e.id)).size !== r.data.extensions.length) {
      throw new SystemFileError(`${SYSTEM_PATH}: an extension is listed twice`)
    }
    return unique({
      core: r.data.core,
      modules: r.data.extensions.map((e) => ({ ...e, bundleSha256: null })),
      apps: r.data.apps,
    })
  }
  const r = systemSchema.safeParse(value)
  if (!r.success) problem(r)
  return unique({ ...(r.data.core ? { core: r.data.core } : {}), modules: r.data.modules, apps: r.data.apps })
}

/** Canonical v2 bytes: keys sorted, modules by id, apps by name. Every module carries its bundle. */
export function serializeSystem(pin: SystemPin): string {
  const missing = pin.modules.find((m) => m.bundleSha256 === null)
  if (missing) {
    throw new SystemFileError(`${SYSTEM_PATH}: module ${missing.id} has no bundleSha256 (a v2 pin pins its bundle)`)
  }
  const value = { format: SYSTEM_FORMAT, version: SYSTEM_VERSION, ...pin }
  const r = systemSchema.safeParse(value)
  if (!r.success) problem(r)
  unique(pin)
  return canonicalYaml({
    ...r.data,
    modules: [...r.data.modules].sort((a, b) => (a.id < b.id ? -1 : 1)),
    apps: [...r.data.apps].sort((a, b) => (a.name < b.name ? -1 : 1)),
  })
}

export function parseSystem(text: string): SystemPin {
  return check(parseYaml(text))
}

/** The restore path's reader: system.yaml at a ref of the data repo (null when the repo has none yet). */
export async function readSystemPin(read: (path: string) => Promise<Uint8Array | null>): Promise<SystemPin | null> {
  const bytes = await read(SYSTEM_PATH)
  return bytes ? parseSystem(Buffer.from(bytes).toString('utf8')) : null
}

/**
 * The next system.yaml with one module pinned (or unpinned with null): the
 * module host writes it once ee reports a deploy running, and on a removal.
 * Everything else in the file is kept as it was (a v1 file is rewritten as v2;
 * its other modules must then have been redeployed with a bundle).
 */
export function pinSystemModule(
  current: string | null,
  moduleId: string,
  entry: { version: string; commit: string; bundleSha256: string } | null,
): string {
  const pin: SystemPin = current === null ? { modules: [], apps: [] } : parseSystem(current)
  const modules = pin.modules.filter((m) => m.id !== moduleId)
  if (entry) modules.push({ id: moduleId, ...entry })
  return serializeSystem({ ...pin, modules })
}
