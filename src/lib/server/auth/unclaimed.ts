import { count, eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { env } from '$lib/server/env/private-env'
import { foundingCompanyName } from '$lib/server/overview/sources'
import { signInGate, UnclaimedServerError } from './owner-policy'

export async function countUsers(): Promise<number> {
  const [row] = await authDb.select({ n: count() }).from(user)
  return Number(row?.n ?? 0)
}

/** Whether ee manages this server (ee sets EE_WORKLOAD on every workload it runs, ee/src/units.ts). */
export const managedByEe = (): boolean => Boolean(env.EE_WORKLOAD)

/**
 * On a server ee manages, nobody can sign up or sign in before the installer
 * claimed it — the signup/login pages say so instead of offering a form.
 * Once claimed this is null: everyone sees the normal sign-in.
 */
export async function unclaimedMessage(): Promise<string | null> {
  if (!managedByEe()) return null
  return (await countUsers()) === 0 ? new UnclaimedServerError().message : null
}

/** Before a sign-in code is sent: the plain not-a-member answer for an address without an account, else null. */
export async function signInRefusal(email: string): Promise<string | null> {
  if (!managedByEe()) return null
  const [existing] = await authDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1)
  return signInGate({
    managedByEe: true,
    existingUsers: await countUsers(),
    accountExists: Boolean(existing),
    companyName: existing ? null : await foundingCompanyName(),
  })
}
