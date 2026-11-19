/**
 * "Sign in again first" for the few account changes that add or remove a way in (a passkey, a
 * linked sign-in). Better Auth's own check (`freshAge`) is off: it asks for a sign-in within the
 * last day even when the account has no way to sign in again, and sessions here last a year — an
 * owner who skipped the passkey on a box without email could then never add one.
 *
 * So: a sign-in older than a day must be renewed with an email code, but only when company email
 * can deliver that code. Without email, the session is the account's only credential and stands.
 */
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'

export const FRESH_SESSION_MS = 24 * 60 * 60 * 1000

/** Better Auth endpoints (paths under /api/auth) that need a recent sign-in. */
export const FRESH_SESSION_PATHS = ['/passkey/generate-register-options', '/unlink-account'] as const

export const SESSION_NOT_FRESH_CODE = 'SESSION_NOT_FRESH'
export const SESSION_NOT_FRESH_MESSAGE =
  'You signed in more than a day ago. Sign out, sign in again with the code we email you, then add the passkey.'

export function needsFreshSignIn(input: { signedInAt: Date; now: Date; mailConfigured: boolean }): boolean {
  if (input.now.getTime() - input.signedInAt.getTime() < FRESH_SESSION_MS) return false
  return input.mailConfigured
}

/** Better Auth `hooks.before`: refuses the guarded endpoints with SESSION_NOT_FRESH when needed. */
export function freshSessionHook(mailConfigured: () => Promise<boolean>) {
  return createAuthMiddleware(async (ctx) => {
    if (!(FRESH_SESSION_PATHS as readonly string[]).includes(ctx.path)) return
    const current = await getSessionFromCtx(ctx)
    if (!current?.session) return // the endpoint's own session check answers 401
    const stale = needsFreshSignIn({
      signedInAt: new Date(current.session.createdAt),
      now: new Date(),
      mailConfigured: await mailConfigured(),
    })
    if (stale) throw new APIError('FORBIDDEN', { code: SESSION_NOT_FRESH_CODE, message: SESSION_NOT_FRESH_MESSAGE })
  })
}
