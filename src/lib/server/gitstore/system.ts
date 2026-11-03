import { z } from 'zod'
import { canonicalYaml, parseYaml } from './canonical'
import { LAYOUT } from './layout'

/**
 * `system.yaml` at the data repo root (plan/phase-git-native.md §8): pins
 * exactly what runs — the core release + commit, every extension (id,
 * version, commit) and every installed app (name + source commit). A restore
 * reads it and installs exactly that before rebuilding the index. Every change
 * is a commit authored by the person who deployed/updated.
 */

export const SYSTEM_PATH = LAYOUT.system
export const SYSTEM_FORMAT = 'eigen.system'
export const SYSTEM_VERSION = 1

const commit = z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character git commit hash')
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'a semver version')

export const systemSchema = z
  .object({
    format: z.literal(SYSTEM_FORMAT),
    version: z.literal(SYSTEM_VERSION),
    core: z.object({ release: semver, commit }).strict(),
    extensions: z
      .array(
        z
          .object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), version: semver, commit })
          .strict(),
      )
      .default([]),
    apps: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
            source: z.string().min(1),
            commit,
          })
          .strict(),
      )
      .default([]),
  })
  .strict()

export type SystemPin = z.infer<typeof systemSchema>

export class SystemFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SystemFileError'
  }
}

function check(value: unknown): SystemPin {
  const header = value as { format?: unknown; version?: unknown } | null
  if (
    header &&
    header.format === SYSTEM_FORMAT &&
    typeof header.version === 'number' &&
    header.version > SYSTEM_VERSION
  ) {
    throw new SystemFileError(
      `${SYSTEM_PATH} is ${SYSTEM_FORMAT} v${header.version}; this code reads v${SYSTEM_VERSION} — restore with a newer installer`,
    )
  }
  const r = systemSchema.safeParse(value)
  if (!r.success) {
    const i = r.error.issues[0]
    throw new SystemFileError(
      `${SYSTEM_PATH}: ${i?.path.join('.') || 'file'}: ${i?.message ?? 'invalid'}`,
    )
  }
  const ext = r.data.extensions.map((e) => e.id)
  if (new Set(ext).size !== ext.length)
    throw new SystemFileError(`${SYSTEM_PATH}: an extension is listed twice`)
  const apps = r.data.apps.map((a) => a.name)
  if (new Set(apps).size !== apps.length)
    throw new SystemFileError(`${SYSTEM_PATH}: an app is listed twice`)
  return r.data
}

/** Canonical bytes: keys sorted, extensions by id, apps by name. */
export function serializeSystem(
  pin: Omit<SystemPin, 'format' | 'version'> & Partial<Pick<SystemPin, 'format' | 'version'>>,
): string {
  const v = check({ ...pin, format: SYSTEM_FORMAT, version: SYSTEM_VERSION })
  return canonicalYaml({
    ...v,
    extensions: [...v.extensions].sort((a, b) => (a.id < b.id ? -1 : 1)),
    apps: [...v.apps].sort((a, b) => (a.name < b.name ? -1 : 1)),
  })
}

export function parseSystem(text: string): SystemPin {
  return check(parseYaml(text))
}

/** The restore path's reader: system.yaml at a ref of the data repo (null when the repo has none yet). */
export async function readSystemPin(
  read: (path: string) => Promise<Uint8Array | null>,
): Promise<SystemPin | null> {
  const bytes = await read(SYSTEM_PATH)
  return bytes ? parseSystem(Buffer.from(bytes).toString('utf8')) : null
}
