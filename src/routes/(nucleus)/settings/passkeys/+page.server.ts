import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { deviceLabel } from '$lib/auth/session-label'
import { auth } from '$lib/server/auth'

/**
 * Settings → Passkeys & sessions. Both lists load here on the server (the
 * former client-side passkey query could hang on "Loading…" forever); a
 * failing list fails the page loud instead.
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const headers = event.request.headers
  const [passkeys, sessions] = await Promise.all([
    auth.api.listPasskeys({ headers }),
    auth.api.listSessions({ headers }),
  ])
  const currentId = event.locals.session?.id ?? null
  return {
    // Passkeys are bound to the origin the browser sees — shown on the page so
    // a stale bookmark (a different port or host) is easy to recognize.
    origin: event.url.origin,
    passkeys: passkeys.map((pk) => ({
      id: pk.id,
      name: pk.name ?? 'Passkey',
      syncs: pk.deviceType !== 'singleDevice',
      backedUp: pk.backedUp,
      createdAt: new Date(pk.createdAt).toISOString(),
    })),
    sessions: sessions
      .map((s) => ({
        id: s.id,
        current: s.id === currentId,
        device: deviceLabel(s.userAgent),
        ipAddress: s.ipAddress || null,
        signedInAt: new Date(s.createdAt).toISOString(),
        lastActive: new Date(s.updatedAt).toISOString(),
      }))
      .sort(
        (a, b) => Number(b.current) - Number(a.current) || b.lastActive.localeCompare(a.lastActive),
      ),
  }
}
