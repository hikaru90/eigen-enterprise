import type { Actions, PageServerLoad } from './$types'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Suppression: addresses never mailed again (bounced, marked as spam, or added by hand). */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireMember(locals)
  const q = url.searchParams.get('q')?.trim() || undefined
  const rows = await emailPlatform().store.listSuppressions(q)
  return {
    q: q ?? '',
    suppressions: rows.map((r) => ({
      email: r.email,
      reason: r.reason,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    })),
  }
}

export const actions: Actions = {
  add: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const email = field(await request.formData(), 'email')
    return act('add', async () => ({ email: (await emailPlatform().suppress(email, me.userId)).email }))
  },
  remove: async ({ locals, request }) => {
    await requireAdmin(locals)
    const email = field(await request.formData(), 'email')
    return act('remove', async () => {
      await emailPlatform().unsuppress(email)
      return { email }
    })
  },
}
