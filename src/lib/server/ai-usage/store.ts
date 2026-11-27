import type postgres from 'postgres'
import type { AiUsageRow } from '$lib/ai-usage/overview'
import type { AiUsagePort } from '$lib/kernel/ai-usage-tools'
import { ACTIVITY_PAGE_LLM_PROVIDERS } from '$lib/server/activity/gateway-providers'
import { createAdminSql } from '$lib/server/job-queue/admin-db'

/**
 * The company-wide read behind settings.ai_usage_overview. activity_call_log is row-level
 * secured per person, so this reads on the admin connection (like Settings → Export); who may
 * see the result is the tool's permission. Only amounts and names leave: never a row's context.
 */

type Group = {
  userId: string
  name: string
  email: string
  userKind: string
  task: string | null
  model: string | null
  day: string
  costUsd: string
  calls: number
  promptTokens: string
  completionTokens: string
  cachedTokens: string
}

function amount(value: string | number, what: string): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) throw new Error(`activity_call_log ${what} is not a non-negative number: ${value}`)
  return n
}

/** The UTC day after `date` (YYYY-MM-DD). */
function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

export async function readAiUsageRows(
  sql: postgres.Sql | postgres.TransactionSql,
  period: { from: string | null; to: string | null },
): Promise<AiUsageRow[]> {
  // A connection that row-level security still filters would show one person's rows as the company's.
  const [security] = await sql<{ active: boolean }[]>`SELECT row_security_active('activity_call_log') AS active`
  if (security?.active !== false) {
    throw new Error(
      'The AI usage overview needs a database connection that reads every row of activity_call_log (DATABASE_ADMIN_URL); this one is limited by row-level security.',
    )
  }
  const since = period.from === null ? sql`` : sql`AND a.created_at >= ${period.from}::timestamp`
  const before = period.to === null ? sql`` : sql`AND a.created_at < ${dayAfter(period.to)}::timestamp`
  const groups = await sql<Group[]>`
    SELECT
      a.user_id AS "userId",
      u.name,
      u.email,
      u.kind AS "userKind",
      a.task,
      a.model,
      to_char(a.created_at, 'YYYY-MM-DD') AS day,
      COALESCE(SUM(a.total_cost_usd::numeric), 0)::text AS "costUsd",
      COUNT(*)::int AS calls,
      COALESCE(SUM(a.prompt_tokens), 0)::text AS "promptTokens",
      COALESCE(SUM(a.completion_tokens), 0)::text AS "completionTokens",
      COALESCE(SUM(a.cached_tokens), 0)::text AS "cachedTokens"
    FROM activity_call_log a
    JOIN "user" u ON u.id = a.user_id
    WHERE a.provider IN ${sql([...ACTIVITY_PAGE_LLM_PROVIDERS])}
      ${since}
      ${before}
    GROUP BY a.user_id, u.name, u.email, u.kind, a.task, a.model, to_char(a.created_at, 'YYYY-MM-DD')
  `
  return groups.map((g) => ({
    userId: g.userId,
    name: g.name.trim() === '' ? g.email : g.name,
    kind: g.userKind === 'coworker' ? 'coworker' : 'person',
    task: g.task,
    model: g.model,
    day: g.day,
    costUsd: amount(g.costUsd, 'cost'),
    calls: g.calls,
    promptTokens: amount(g.promptTokens, 'prompt tokens'),
    completionTokens: amount(g.completionTokens, 'completion tokens'),
    cachedTokens: amount(g.cachedTokens, 'cached tokens'),
  }))
}

export const liveAiUsagePort: AiUsagePort = {
  async rows(period) {
    const sql = createAdminSql(1)
    try {
      return await readAiUsageRows(sql, period)
    } finally {
      await sql.end()
    }
  },
}
