import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { appSql } from '$lib/server/db'

/**
 * Health gate for ee (plan/phase-substrate.md §3.4): a new release only takes
 * traffic once this answers 200. Healthy = the process serves AND reaches Postgres.
 */
export const GET: RequestHandler = async () => {
  try {
    await appSql`SELECT 1 AS ok`
    return json({ ok: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return json({ ok: false, error: `database: ${message}` }, { status: 503 })
  }
}
