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

/**
 * Handover is gone (owner wish f3fc516e, 2026-11-28): its page, tab and Memory
 * nav entry are removed; the handover.* tools keep working until their window
 * ends, then they go with a major bump. Its tables stay (expand/contract).
 */
const HANDOVER_GONE =
  'Handover was removed from eigenEnterprise; nothing replaces it. Stop calling handover.* — ' +
  'keep "where things stand" as a Memory document (memory.create_text_file {title, content}) ' +
  'and hand work over with tasks.assign {title, assignee_id}.'

const HANDOVER_DEPRECATIONS: readonly Deprecation[] = [
  'handover.create',
  'handover.list',
  'handover.get',
  'handover.add_entry',
  'handover.update_entry',
  'handover.remove_entry',
  'handover.delete',
  'handover.assign_entry',
  'handover.draft_entry',
].map((name) => ({
  item: `tool:${name}`,
  since: '0.5.48',
  sinceDate: '2026-11-28',
  replacement: null,
  howToMigrate: HANDOVER_GONE,
}))



/**
 * The model behind eigenInference is not named (wish 60bd7be2, 2026-11-28): the
 * co-worker's `modelId` and the settings' `ai.modelProvider` keep their old shape
 * until their window ends; what a person may see is now the additive label.
 */
const MODEL_ID_TO_LABEL =
  'Show modelLabel instead of modelId: it is "eigenInference" when the company runs on eigenInference ' +
  '(no model is named there) and the model id on the company\'s own key. ' +
  'Example: coworkers.get {user_id} → read .modelLabel, not .modelId. To pick a model keep passing model_id to coworkers.update (own key only).'
const PROVIDER_TO_LABEL =
  'Show ai.providerLabel instead of ai.modelProvider: it is "eigenInference" on eigenInference (no provider named) ' +
  'and the provider (e.g. "openrouter") on the company\'s own key. Example: settings.get {} → read .ai.providerLabel.'

const LABEL_DEPRECATIONS: readonly Deprecation[] = [
  ...['create', 'get', 'update', 'enable', 'disable', 'remove'].map((verb) => ({
    item: `tool:coworkers.${verb}.output.modelId`,
    since: '0.5.48',
    sinceDate: '2026-11-28',
    replacement: `tool:coworkers.${verb}.output.modelLabel`,
    howToMigrate: MODEL_ID_TO_LABEL,
  })),
  {
    item: 'tool:coworkers.list.output.coworkers.[].modelId',
    since: '0.5.48',
    sinceDate: '2026-11-28',
    replacement: 'tool:coworkers.list.output.coworkers.[].modelLabel',
    howToMigrate: MODEL_ID_TO_LABEL,
  },
  ...['get', 'update'].map((verb) => ({
    item: `tool:settings.${verb}.output.ai.modelProvider`,
    since: '0.5.48',
    sinceDate: '2026-11-28',
    replacement: `tool:settings.${verb}.output.ai.providerLabel`,
    howToMigrate: PROVIDER_TO_LABEL,
  })),
]

export const DEPRECATIONS: readonly Deprecation[] = [...HANDOVER_DEPRECATIONS, ...LABEL_DEPRECATIONS]

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
