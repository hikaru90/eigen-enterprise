import { and, eq, gte, sql } from 'drizzle-orm'
import { replyCostSchema, type ReplyCost } from '$lib/ai-usage/usage'
import type { MemberRole } from '$lib/server/auth/roles'
import { getDb } from '$lib/server/db'
import { demoGuestAccess, type UserKind } from '$lib/server/db/auth.schema'
import { companyAi } from '$lib/server/db/company.schema'
import { activityCallLog, chatMessage } from '$lib/server/db/schema'
import type { ActiveDemoGuest } from '$lib/server/demo/guest-access'
import { parseStoredCapUsd } from './member-daily-cap'

/**
 * Storage behind the per-person daily AI cap (DC3): the cap on the company_ai row (migration
 * 0167), a person's role, and what their model calls cost since a moment — summed from the
 * gateway's cost log (activity_call_log.total_cost_usd, what the company is billed per call).
 */

const ROW = 'company'
const MISSING_ROW = 'The company AI settings row is missing (migration 0160_company_ai did not run).'

export type MemberDailyCapStore = {
  readCapUsd(): Promise<number | null>
  setCapUsd(value: number | null, by: string): Promise<void>
  roleOf(userId: string): Promise<MemberRole | null>
  kindOf(userId: string): Promise<UserKind | null>
  spentUsdSince(userId: string, since: Date): Promise<number>
  replyCost(userId: string, messageId: string): Promise<{ usage: ReplyCost | null } | null>
  /** Login-free demo per-IP AI call limit store (loaded lazily so non-demo tests stay DB-free). */
  demoGuest?: {
    activeDemoGuest(): Promise<ActiveDemoGuest | null>
    claimCall(ipHash: string, dayUtc: string, limit: number): Promise<{ allowed: boolean; used: number }>
  }
}

export const memberDailyCapStore: MemberDailyCapStore = {
  async readCapUsd() {
    const [row] = await getDb()
      .select({ cap: companyAi.memberDailyCapUsd })
      .from(companyAi)
      .where(eq(companyAi.id, ROW))
      .limit(1)
    if (!row) throw new Error(MISSING_ROW)
    return parseStoredCapUsd(row.cap)
  },

  async setCapUsd(value, by) {
    if (value !== null && !(Number.isFinite(value) && value > 0)) {
      throw new Error(`The daily AI cap per member must be a positive USD amount or null; got ${value}.`)
    }
    const updated = await getDb()
      .update(companyAi)
      .set({ memberDailyCapUsd: value === null ? null : value.toFixed(4), updatedBy: by, updatedAt: new Date() })
      .where(eq(companyAi.id, ROW))
      .returning({ id: companyAi.id })
    if (updated.length !== 1) throw new Error(MISSING_ROW)
  },

  // Loaded on first use: the auth database opens on import (no DB for callers that never cap).
  roleOf: async (userId) => (await import('$lib/server/auth/user-role')).getUserRole(userId),
  kindOf: async (userId) => (await import('$lib/server/auth/user-role')).getUserKind(userId),

  // What one of the person's assistant replies cost (handle-agent-chat-post keeps it as metadata.usage).
  async replyCost(userId, messageId) {
    const [row] = await getDb()
      .select({ metadata: chatMessage.metadata })
      .from(chatMessage)
      .where(and(eq(chatMessage.id, messageId), eq(chatMessage.userId, userId), eq(chatMessage.role, 'assistant')))
      .limit(1)
    if (!row) return null
    const stored = (row.metadata as { usage?: unknown } | null)?.usage
    if (stored === undefined) return { usage: null }
    const parsed = replyCostSchema.safeParse(stored)
    if (!parsed.success) {
      throw new Error(`chat_message ${messageId} holds a malformed reply cost: ${parsed.error.message}`)
    }
    return { usage: parsed.data }
  },

  async spentUsdSince(userId, since) {
    const [row] = await getDb()
      .select({ total: sql<string>`coalesce(sum(${activityCallLog.totalCostUsd}::numeric), 0)` })
      .from(activityCallLog)
      .where(and(eq(activityCallLog.userId, userId), gte(activityCallLog.createdAt, since)))
    const total = Number(row?.total)
    if (!Number.isFinite(total) || total < 0) {
      throw new Error(`activity_call_log cost sum for a person is not a non-negative number: ${JSON.stringify(row?.total)}`)
    }
    return total
  },

  demoGuest: {
    activeDemoGuest: async () => {
      // Fast pre-check on the request's scoped DB so normal companies (and
      // unit tests that mock getDb()) never open authDb when demo guest access is off.
      const [row] = await getDb()
        .select({ enabled: demoGuestAccess.enabled, guestUserId: demoGuestAccess.guestUserId })
        .from(demoGuestAccess)
        .where(eq(demoGuestAccess.id, ROW))
        .limit(1)
      if (!row || row.enabled !== true || typeof row.guestUserId !== 'string' || !row.guestUserId) {
        return null
      }
      return (await import('$lib/server/demo/guest-access-db')).activeDemoGuest()
    },
    claimCall: async (ipHash, dayUtc, limit) =>
      (await import('$lib/server/demo/guest-access-db')).claimDemoGuestAiCall(ipHash, dayUtc, limit),
  },
}
