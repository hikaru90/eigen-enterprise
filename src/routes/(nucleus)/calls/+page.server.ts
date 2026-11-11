import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { CALLS_DEPENDENCY } from '$lib/calls/format'

/**
 * /calls (plan/video-calls.md §3): my recent calls (who, when, how long,
 * missed / declined), live calls to rejoin, and the company's people for
 * "New meeting" (every member may start one — owner decision 6). Whether the
 * server has LiveKit is stated plainly (`notConfigured`), never hidden.
 */
export const load: PageServerLoad = async ({ locals, depends }) => {
  if (!locals.user) throw redirect(302, '/login')
  depends(CALLS_DEPENDENCY)
  const { liveCallsService } = await import('../../../../modules/index')
  const { CallsError, livekitConfig } = await import('../../../../modules/calls/index')
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const { avatarUrl, isAvatarSha } = await import('$lib/profile/profile')

  let notConfigured: string | null = null
  try {
    livekitConfig(process.env)
  } catch (err) {
    if (!(err instanceof CallsError) || err.code !== 'not_configured') throw err
    notConfigured = err.message
  }

  const [calls, members] = await Promise.all([
    (await liveCallsService()).list({ kind: 'user', userId: locals.user.id }),
    dbMemberStore.listMembers(),
  ])
  return {
    me: locals.user.id,
    notConfigured,
    calls,
    people: members.map((m) => ({
      id: m.id,
      name: m.name.trim() || m.email,
      email: m.email,
      image: isAvatarSha(m.avatarSha256) ? avatarUrl(m.avatarSha256) : null,
    })),
  }
}
