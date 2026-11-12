import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { deviceLabel } from '$lib/auth/session-label'
import { auth } from '$lib/server/auth'

/**
 * Settings → Passkeys & sessions. Both lists load here on the server (the
 * former client-side passkey query could hang on "Loading…" forever); a
 * failing list fails the page loud instead.
 *
 * Sessions are read through Better Auth's internal adapter, not
 * `auth.api.listSessions`: that endpoint only answers a "fresh" session (one
 * signed in within the last day), and sessions here last a year — every
 * machine signed in before yesterday got a 500. The page shows device, place
 * and dates only; tokens never leave the server.
 */
export const load: PageServerLoad = async (event) => {
  const user = event.locals.user
  if (!user) throw redirect(302, '/login')
  const headers = event.request.headers
  const [passkeys, sessions] = await Promise.all([
    auth.api.listPasskeys({ headers }),
    auth.$context.then((ctx) =>
      ctx.internalAdapter.listSessions(user.id, { onlyActiveSessions: true }),
    ),
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
