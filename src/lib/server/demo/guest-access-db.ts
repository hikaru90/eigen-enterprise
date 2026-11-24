import { and, eq, sql } from 'drizzle-orm'
import { DEMO_MODULE_ID } from '../../../../modules/demo/manifest'
import { authDb } from '$lib/server/db/auth-db'
import { demoGuestAccess, demoGuestAiUsage, user } from '$lib/server/db/auth.schema'
import { kernelModuleActivations } from '$lib/server/db/kernel.schema'
import {
  resolveActiveDemoGuest,
  type ActiveDemoGuest,
  type DemoGuestStore,
  type DemoGuestUserRecord,
} from './guest-access'

/**
 * Postgres persistence for login-free demo guest access (migration 0178) and
 * per-IP daily AI turn counting. Uses `authDb` so signed-out pages (/login,
 * /signup) and server-side checks work without an RLS tenant user.
 */

const ROW = 'company'

export const dbDemoGuestStore: DemoGuestStore = {
  async get() {
    const [row] = await authDb
      .select({
        enabled: demoGuestAccess.enabled,
        guestUserId: demoGuestAccess.guestUserId,
        aiCallsPerIp: demoGuestAccess.aiCallsPerIp,
      })
      .from(demoGuestAccess)
      .where(eq(demoGuestAccess.id, ROW))
      .limit(1)
    return row ?? null
  },

  async set(config, actorId) {
    await authDb
      .insert(demoGuestAccess)
      .values({
        id: ROW,
        enabled: config.enabled,
        guestUserId: config.guestUserId,
        aiCallsPerIp: config.aiCallsPerIp,
        updatedBy: actorId,
      })
      .onConflictDoUpdate({
        target: demoGuestAccess.id,
        set: {
          enabled: config.enabled,
          guestUserId: config.guestUserId,
          aiCallsPerIp: config.aiCallsPerIp,
          updatedBy: actorId,
          updatedAt: new Date(),
        },
      })
  },
}

export async function isDemoModuleActiveInDb(): Promise<boolean> {
  const [row] = await authDb
    .select({ active: kernelModuleActivations.active })
    .from(kernelModuleActivations)
    .where(eq(kernelModuleActivations.moduleId, DEMO_MODULE_ID))
    .limit(1)
  return row?.active === true
}

export async function findDemoGuestUserById(id: string): Promise<DemoGuestUserRecord | null> {
  const [row] = await authDb
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      kind: user.kind,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1)
  return row ?? null
}

export async function findDemoGuestUserByEmail(email: string): Promise<DemoGuestUserRecord | null> {
  const normalized = email.trim().toLowerCase()
  const [row] = await authDb
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      kind: user.kind,
    })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalized}`)
    .limit(1)
  return row ?? null
}

/** The active login-free demo guest for this server, or null when off / ineligible. */
export async function activeDemoGuest(): Promise<ActiveDemoGuest | null> {
  return resolveActiveDemoGuest({
    store: dbDemoGuestStore,
    demoModuleActive: isDemoModuleActiveInDb,
    findUserById: findDemoGuestUserById,
  })
}

/** Whether `userId` is currently the active login-free demo guest account. */
export async function isActiveDemoGuestUser(userId: string): Promise<boolean> {
  const active = await activeDemoGuest()
  return active !== null && active.userId === userId
}

/**
 * Atomically claims one AI turn for `(ipHash, dayUtc)` up to `limit`.
 * Returns `allowed: true` when the increment succeeded, `allowed: false` when
 * the IP has already used its daily demo allowance.
 */
export async function claimDemoGuestAiCall(
  ipHash: string,
  dayUtc: string,
  limit: number,
): Promise<{ allowed: boolean; used: number }> {
  if (limit <= 0) return { allowed: false, used: 0 }
  const rows = await authDb
    .insert(demoGuestAiUsage)
    .values({ ipHash, dayUtc, calls: 1 })
    .onConflictDoUpdate({
      target: [demoGuestAiUsage.ipHash, demoGuestAiUsage.dayUtc],
      set: {
        calls: sql`${demoGuestAiUsage.calls} + 1`,
        updatedAt: new Date(),
      },
      where: sql`${demoGuestAiUsage.calls} < ${limit}`,
    })
    .returning({ calls: demoGuestAiUsage.calls })

  if (rows.length === 1) {
    return { allowed: true, used: rows[0]!.calls }
  }

  const [existing] = await authDb
    .select({ calls: demoGuestAiUsage.calls })
    .from(demoGuestAiUsage)
    .where(and(eq(demoGuestAiUsage.ipHash, ipHash), eq(demoGuestAiUsage.dayUtc, dayUtc)))
    .limit(1)
  return { allowed: false, used: existing?.calls ?? limit }
}
