import type { MemberRole } from '$lib/server/auth/roles'
import type { UserKind } from '$lib/server/db/auth.schema'
import { resolveTenantUserId } from '$lib/server/db/tenant-context'
import { LlmDailyCapError } from './errors'

/**
 * The company's per-person daily AI cap (plan/phase-demo-company.md D2, DC3), enforced at the
 * gateway boundary: every model call (chat, embeddings, speech to text, text to speech) made
 * for a person with role `member` is refused once what that person's calls cost today (UTC)
 * reaches the cap. Owner and admins are exempt; an unset cap caps nobody.
 *
 * The person is the one the call is logged to — the tenant user when one is set, else the
 * call's userId — exactly as the cost log (activity_call_log) attributes it, so the count and
 * the cap always look at the same rows.
 */

export type MemberDailyCapDeps = {
  readCapUsd(): Promise<number | null>
  roleOf(userId: string): Promise<MemberRole | null>
  /**
   * A person or an AI co-worker. A co-worker holds role member but is no person's seat
   * (plan/phase-ai-coworkers.md §3): its own daily_cap_usd caps it (AgentRuntime, on the same
   * cost ledger), never the company's per-member cap.
   */
  kindOf(userId: string): Promise<UserKind | null>
  spentUsdSince(userId: string, since: Date): Promise<number>
  now(): Date
}

/**
 * The stored cap: null = no cap; otherwise a positive decimal string (Postgres numeric).
 * Anything else is a broken row and fails loud — never read as "no cap".
 */
export function parseStoredCapUsd(raw: unknown): number | null {
  if (raw === null) return null
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `company_ai.member_daily_cap_usd holds ${JSON.stringify(raw)}; it must be NULL (no cap) or a positive USD amount.`,
    )
  }
  return value
}

/** The live store, loaded on first use (it opens the database on import). */
const store = async () => (await import('./member-daily-cap-store')).memberDailyCapStore

export const liveMemberDailyCapDeps: MemberDailyCapDeps = {
  readCapUsd: async () => (await store()).readCapUsd(),
  roleOf: async (userId) => (await store()).roleOf(userId),
  kindOf: async (userId) => (await store()).kindOf(userId),
  spentUsdSince: async (userId, since) => (await store()).spentUsdSince(userId, since),
  now: () => new Date(),
}

/** Midnight UTC at the start of `now`'s UTC day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

/** The next midnight UTC after `now` (when today's count starts again). */
export function nextUtcMidnight(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 24 * 60 * 60 * 1000)
}

export type MemberAiUsage = {
  role: MemberRole | null
  capUsd: number | null
  capApplies: boolean
  spentUsd: number
  remainingUsd: number | null
  resetsAt: string
}

/** A person's AI usage today (UTC) against the company's cap. */
export async function memberAiUsageToday(
  userId: string,
  deps: MemberDailyCapDeps = liveMemberDailyCapDeps,
): Promise<MemberAiUsage> {
  const now = deps.now()
  const [capUsd, role, kind, spentUsd] = await Promise.all([
    deps.readCapUsd(),
    deps.roleOf(userId),
    deps.kindOf(userId),
    deps.spentUsdSince(userId, utcDayStart(now)),
  ])
  const capApplies = capUsd !== null && role === 'member' && kind === 'human'
  return {
    role,
    capUsd,
    capApplies,
    spentUsd,
    remainingUsd: capApplies ? Math.max(0, capUsd - spentUsd) : null,
    resetsAt: nextUtcMidnight(now).toISOString(),
  }
}

/**
 * Refuses (LlmDailyCapError) a model call for a member whose calls today reached the cap.
 * Reads the cap first: with no cap set it costs one row read and nothing else.
 */
export async function assertWithinMemberDailyCap(
  userId: string,
  deps: MemberDailyCapDeps = liveMemberDailyCapDeps,
): Promise<void> {
  const capUsd = await deps.readCapUsd()
  if (capUsd === null) return
  if ((await deps.roleOf(userId)) !== 'member') return
  // An AI co-worker is capped by its own daily cap only (see kindOf).
  if ((await deps.kindOf(userId)) !== 'human') return
  const spentUsd = await deps.spentUsdSince(userId, utcDayStart(deps.now()))
  if (spentUsd >= capUsd) throw new LlmDailyCapError({ capUsd, spentUsd })
}

/** The gateway's check: the person the call is logged to (tenant user, else the caller). */
export function assertGatewayCallWithinMemberDailyCap(userId: string): Promise<void> {
  return assertWithinMemberDailyCap(resolveTenantUserId(userId))
}
