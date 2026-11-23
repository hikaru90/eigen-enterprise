import type { Catalog } from './plan'
import type postgres from 'postgres'

/**
 * The schemas Postgres or its extensions own. Everything else in the company
 * database is the company's and must have an export rule.
 */
export const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast'] as const

/** Every base table of the database with its columns, in catalog order (`schema.table` outside public). */
export async function readCatalog(sql: postgres.Sql): Promise<Catalog> {
  const rows = await sql<{ table_schema: string; table_name: string; column_name: string }[]>`
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema NOT IN ${sql(SYSTEM_SCHEMAS as unknown as string[])}
      AND c.table_schema NOT LIKE 'pg_temp%'
    ORDER BY c.table_schema, c.table_name, c.ordinal_position`
  const out: Record<string, string[]> = {}
  for (const r of rows) {
    const key = r.table_schema === 'public' ? r.table_name : `${r.table_schema}.${r.table_name}`
    ;(out[key] ??= []).push(r.column_name)
  }
  return out
}

/** Streams a planned SELECT in batches through a cursor (a big table never sits in memory). */
export async function* cursorRows(sql: postgres.Sql, query: string, batch = 500): AsyncIterable<readonly Record<string, unknown>[]> {
  for await (const rows of sql.unsafe(query).cursor(batch)) yield rows
}
