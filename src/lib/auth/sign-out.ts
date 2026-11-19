/**
 * Sign out through /api/session/sign-out. `lockout` comes back (nothing signed out) when this would
 * end the only way back in — no passkey and no company email; `confirmLockout` signs out anyway.
 */
export async function requestSignOut(confirmLockout = false): Promise<{ ok: true } | { ok: false; lockout: string }> {
  const res = await fetch('/api/session/sign-out', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmLockout }),
  })
  if (res.status === 409) {
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null
    if (body?.code === 'would_lock_out' && body.message) return { ok: false, lockout: body.message }
  }
  if (!res.ok) throw new Error(`Sign out failed (HTTP ${res.status}).`)
  return { ok: true }
}
