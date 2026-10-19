import { count } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { env } from '$lib/server/env/private-env'
import { UnclaimedServerError } from './owner-policy'

/**
 * On a server ee manages, nobody can sign up or sign in before the installer
 * claimed it — the signup/login pages say so instead of offering a form.
 */
export async function unclaimedMessage(): Promise<string | null> {
  if (!env.EE_WORKLOAD) return null
  const [row] = await authDb.select({ n: count() }).from(user)
  return Number(row?.n ?? 0) === 0 ? new UnclaimedServerError().message : null
}
