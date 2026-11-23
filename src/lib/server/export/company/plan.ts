/**
 * The company export's table plan (plan/phase-export.md §2, §6). Every table
 * in the database has exactly one rule; a table without one, or a rule for a
 * table that no longer exists, stops the export loudly. "Everything" is the
 * live catalog, not a list someone remembered to update.
 *
 * - `full`: every row, every column except `secret` ones (never leave in plain text).
 * - `private-as-meta`: rows matching `privateWhen` (a SQL predicate over the
 *   row) keep only their `meta` columns; every other row is exported in full.
 *   Every column must be named as meta, content or secret — an unnamed column
 *   is an error, never a guess.
 * - `excluded`: not exported, with the reason written down (sessions, caches,
 *   rows derived from other tables). The manifest lists every exclusion.
 */

export type TableRule =
  | { export: 'full'; secret?: readonly string[] }
  | {
      export: 'private-as-meta'
      /** SQL predicate over the row (alias `t`) that is true for a member's private row. */
      privateWhen: string
      meta: readonly string[]
      content: readonly string[]
      secret?: readonly string[]
    }
  | { export: 'excluded'; reason: string }

/** table name (`name` in public, `schema.name` elsewhere) → its columns, in catalog order. */
export type Catalog = Record<string, readonly string[]>

export type TablePlan =
  | { table: string; export: 'excluded'; reason: string }
  | { table: string; export: 'rows'; sql: string; secret: string[]; hasPrivate: boolean }

export class ExportPlanError extends Error {
  constructor(readonly problems: string[]) {
    super(`company export refused — the table rules don't match the database:\n- ${problems.join('\n- ')}`)
    this.name = 'ExportPlanError'
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENT.test(name)) throw new ExportPlanError([`not a plain identifier: ${JSON.stringify(name)}`])
  return `"${name}"`
}

/** `contact` (public schema) or `eigen_graph.node` → a quoted table reference. */
function tableRef(name: string): string {
  return name.split('.').map(ident).join('.')
}

/**
 * Checks the rules against the catalog and builds one SELECT per exported table. Pure.
 * `excludedSchemas`: whole schemas left out with a reason (server plumbing, derived data).
 */
export function planCompanyExport(
  catalog: Catalog,
  rules: Record<string, TableRule>,
  excludedSchemas: Record<string, string> = {},
): TablePlan[] {
  const problems: string[] = []
  const schemaOf = (t: string) => (t.includes('.') ? t.slice(0, t.indexOf('.')) : 'public')
  const schemaExcluded = Object.keys(catalog).filter((t) => excludedSchemas[schemaOf(t)] !== undefined).sort()
  const tables = Object.keys(catalog).filter((t) => excludedSchemas[schemaOf(t)] === undefined).sort()
  for (const t of schemaExcluded) if (rules[t]) problems.push(`${t}: has a rule but its whole schema is excluded`)

  for (const t of tables) if (!rules[t]) problems.push(`${t}: no export rule (classify it in src/lib/server/export/company/rules.ts)`)
  for (const t of Object.keys(rules)) if (!catalog[t]) problems.push(`${t}: has a rule but is not in the database`)

  for (const t of tables) {
    const rule = rules[t]
    if (!rule || rule.export === 'excluded') continue
    const cols = new Set(catalog[t])
    for (const c of rule.secret ?? []) if (!cols.has(c)) problems.push(`${t}.${c}: marked secret but no such column`)
    if (rule.export === 'private-as-meta') {
      const named = [...rule.meta, ...rule.content, ...(rule.secret ?? [])]
      const seen = new Set<string>()
      for (const c of named) {
        if (!cols.has(c)) problems.push(`${t}.${c}: named in the rule but no such column`)
        if (seen.has(c)) problems.push(`${t}.${c}: named twice (meta, content and secret are exclusive)`)
        seen.add(c)
      }
      for (const c of catalog[t]) if (!seen.has(c)) problems.push(`${t}.${c}: unclassified column (meta, content or secret)`)
      if (rule.meta.length === 0) problems.push(`${t}: a private row needs at least one meta column`)
    }
  }
  if (problems.length) throw new ExportPlanError(problems)

  const planned = tables.map((t): TablePlan => {
    const rule = rules[t]
    if (rule.export === 'excluded') return { table: t, export: 'excluded', reason: rule.reason }
    const secret = [...(rule.secret ?? [])]
    const full = secret.reduce((expr, c) => `${expr} - '${c}'`, 'to_jsonb(t)')
    if (rule.export === 'full') {
      return { table: t, export: 'rows', secret, hasPrivate: false, sql: `SELECT ${full} AS row FROM ${tableRef(t)} t` }
    }
    const meta = rule.meta.map((c) => `'${c}', t.${ident(c)}`).join(', ')
    const row =
      `CASE WHEN (${rule.privateWhen}) ` +
      `THEN jsonb_build_object(${meta}) || '{"_private": true}'::jsonb ` +
      `ELSE ${full} END`
    return { table: t, export: 'rows', secret, hasPrivate: true, sql: `SELECT ${row} AS row FROM ${tableRef(t)} t` }
  })
  return [
    ...planned,
    ...schemaExcluded.map((t): TablePlan => ({ table: t, export: 'excluded', reason: excludedSchemas[schemaOf(t)] })),
  ]
}
