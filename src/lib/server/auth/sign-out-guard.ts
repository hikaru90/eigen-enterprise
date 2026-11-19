/**
 * Signing out ends the only way back in when the account has no passkey and company email (sign-in
 * codes) isn't set up — the owner of a fresh box, typically. Sign-out then asks first instead of
 * locking them out; "Sign out anyway" goes through.
 */

export const WOULD_LOCK_OUT = 'would_lock_out'
export const WOULD_LOCK_OUT_MESSAGE =
  'You have no passkey and company email isn’t set up, so you couldn’t sign in again after signing out. Add a passkey first.'

export async function signOutWouldLockOut(deps: { passkeys: () => Promise<number>; mailConfigured: () => Promise<boolean> }): Promise<boolean> {
  if ((await deps.passkeys()) > 0) return false
  return !(await deps.mailConfigured())
}
