/**
 * Module merge of plan/phase-platform.md step 1 ("Module merge, no behaviour
 * change"): which old module ids each merged module absorbed. Single source
 * for the activation migration (drizzle/0092_module_merge.sql is generated
 * from this and pinned by test) and its pure equivalent below.
 *
 * Tool names did NOT change: a merged module owns the old ids as tool
 * namespaces (ModuleManifest.toolNamespaces), so stored approvals, events and
 * journey artifacts that name e.g. `substrate.domain_add` stay valid.
 */
export const MODULE_MERGES = {
  website: ['website', 'substrate', 'github'],
  email: ['email', 'owlery'],
  orchestrator: ['repo', 'dev-agent', 'roadmap'],
} as const satisfies Record<string, readonly string[]>

export type MergedModuleId = keyof typeof MODULE_MERGES

/** Old ids that no longer exist as modules (their activation rows are removed). */
export const RETIRED_MODULE_IDS: readonly string[] = Object.entries(MODULE_MERGES).flatMap(
  ([target, parts]) => parts.filter((part) => part !== target),
)

export const MODULE_MERGE_MIGRATION = '0092_module_merge'

export type ActivationRow = { moduleId: string; active: boolean }

/**
 * The activation rows after the merge: a merged module is active if any of its
 * parts was; it gets a row only if at least one part had one (no row = off,
 * as before). Retired ids are dropped; other rows pass through. Sorted by id.
 */
export function mergeActivations(rows: readonly ActivationRow[]): ActivationRow[] {
  const byId = new Map(rows.map((row) => [row.moduleId, row.active]))
  const out = new Map<string, boolean>()
  for (const row of rows) {
    if (RETIRED_MODULE_IDS.includes(row.moduleId)) continue
    out.set(row.moduleId, row.active)
  }
  for (const [target, parts] of Object.entries(MODULE_MERGES)) {
    const present = parts.filter((part) => byId.has(part))
    if (present.length === 0) continue
    out.set(target, present.some((part) => byId.get(part) === true))
  }
  return [...out.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([moduleId, active]) => ({ moduleId, active }))
}

function quoted(ids: readonly string[]): string {
  return ids.map((id) => `'${id}'`).join(', ')
}

/** The SQL of migration 0092, generated from MODULE_MERGES (same rules as mergeActivations). */
export function moduleMergeSql(): string {
  const header = [
    '-- plan/phase-platform.md step 1: module merge, no behaviour change.',
    '-- website = website + substrate + github; email = email + owlery;',
    '-- orchestrator (internal) = repo + dev-agent + roadmap. A merged module is',
    '-- active if any of its parts was; it gets a row only if a part had one.',
    '-- Tool names are unchanged (merged modules own the old ids as namespaces).',
    '-- Generated from src/lib/kernel/module-merge.ts and pinned by its spec.',
  ].join('\n')
  const upserts = Object.entries(MODULE_MERGES).map(
    ([target, parts]) =>
      `INSERT INTO "kernel_module_activations" ("module_id", "active", "updated_at")\n` +
      `SELECT '${target}', bool_or("active"), now() FROM "kernel_module_activations"\n` +
      `WHERE "module_id" IN (${quoted(parts)})\n` +
      `HAVING count(*) > 0\n` +
      `ON CONFLICT ("module_id") DO UPDATE SET "active" = EXCLUDED."active", "updated_at" = EXCLUDED."updated_at";`,
  )
  const removal = `DELETE FROM "kernel_module_activations" WHERE "module_id" IN (${quoted(RETIRED_MODULE_IDS)});`
  return `${header}\n${[...upserts, removal].join('\n--> statement-breakpoint\n')}\n`
}
