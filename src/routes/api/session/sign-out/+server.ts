import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { count, eq } from 'drizzle-orm'
import { dev } from '$app/environment'
import { auth } from '$lib/server/auth'
import { signOutWouldLockOut, WOULD_LOCK_OUT, WOULD_LOCK_OUT_MESSAGE } from '$lib/server/auth/sign-out-guard'
import { authDb } from '$lib/server/db/auth-db'
import { passkey } from '$lib/server/db/auth.schema'
import { companyMail } from '$lib/server/mail'

/**
 * Outside `/api/auth` so `svelteKitHandler` does not intercept; uses Better Auth server API + request cookies.
 * Body `{ confirmLockout: true }` signs out even when it ends the only way back in (409 `would_lock_out` otherwise).
 */
export const POST: RequestHandler = async (event) => {
  const body = (await event.request.json().catch(() => null)) as { confirmLockout?: unknown } | null
  const user = event.locals.user
  if (user && body?.confirmLockout !== true) {
    const lockout = await signOutWouldLockOut({
      passkeys: async () => Number((await authDb.select({ n: count() }).from(passkey).where(eq(passkey.userId, user.id)))[0]?.n ?? 0),
      // Dev prints sign-in codes to the terminal (deliver-code.ts): a code always gets back in there.
      mailConfigured: async () => dev || (await companyMail().isConfigured()),
    })
    if (lockout) return json({ code: WOULD_LOCK_OUT, message: WOULD_LOCK_OUT_MESSAGE }, { status: 409 })
  }
  await auth.api.signOut({
    headers: event.request.headers,
  })
  return json({ ok: true as const })
}
