/**
 * Declared deprecations of the core contract (plan/phase-upgrades.md R4).
 *
 * A breaking change to `contracts/core-api.lock.json` — a tool, input field,
 * output field, event or UI slot removed or narrowed — passes the gate
 * (`npm run contract:check`) only when an entry here covers it, its window
 * has ended, and `CORE_API_VERSION` took a major bump. While the window runs
 * the old shape keeps working: declare the deprecation, ship the replacement
 * next to it, and remove the old item only after `removeAfter`.
 */

export type Deprecation = {
  /**
   * The contract item, as the gate names it: `tool:<name>`,
   * `tool:<name>.input.<field>[.<field>…]`, `tool:<name>.output.<field>…`,
   * `tool:<name>.permission`, `event:<type>`, `event:<type>.payload.<field>…`
   * or `slot:<name>`; array items are `[]`. A deprecated item covers
   * everything below it (deprecating `tool:contacts.get` covers its fields).
   */
  item: string
  /** The release (package.json version) that first shipped the deprecation. */
  since: string
  /** The date (YYYY-MM-DD) that release shipped. */
  sinceDate: string
  /** The item to use instead, in the same notation, or null when nothing replaces it. */
  replacement: string | null
  /**
   * Written for an agent repairing a module: old → new, with an example call.
   * Required and non-empty; the gate refuses a deprecation without it.
   */
  howToMigrate: string
}

/** Empty today: core-api 1.0.0 has no deprecations. */
export const DEPRECATIONS: readonly Deprecation[] = []

/** Minimum number of minor releases a deprecated item keeps working. */
export const DEPRECATION_MIN_MINOR_RELEASES = 2
/** Minimum number of days a deprecated item keeps working. */
export const DEPRECATION_MIN_DAYS = 30

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export type Semver = [major: number, minor: number, patch: number]

/** Parse `MAJOR.MINOR.PATCH`, or throw. */
export function parseSemver(version: string): Semver {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`"${version}" is not a MAJOR.MINOR.PATCH version`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function isSemver(version: string): boolean {
  return SEMVER.test(version)
}

export function compareSemver(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

export function isIsoDate(date: string): boolean {
  return (
    ISO_DATE.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date
  )
}

/**
 * When a deprecated item may be removed: at least 2 minor releases after
 * `since` AND at least 30 days after `sinceDate` — both must have passed.
 */
export function removeAfter(deprecation: Pick<Deprecation, 'since' | 'sinceDate'>): {
  release: string
  date: string
} {
  const [major, minor] = parseSemver(deprecation.since)
  if (!isIsoDate(deprecation.sinceDate)) {
    throw new Error(`"${deprecation.sinceDate}" is not a YYYY-MM-DD date`)
  }
  const date = new Date(`${deprecation.sinceDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + DEPRECATION_MIN_DAYS)
  return {
    release: `${major}.${minor + DEPRECATION_MIN_MINOR_RELEASES}.0`,
    date: date.toISOString().slice(0, 10),
  }
}

/** True once both halves of the window have passed for this release and day. */
export function windowEnded(
  deprecation: Pick<Deprecation, 'since' | 'sinceDate'>,
  release: string,
  today: string,
): boolean {
  const end = removeAfter(deprecation)
  return compareSemver(release, end.release) >= 0 && today >= end.date
}
