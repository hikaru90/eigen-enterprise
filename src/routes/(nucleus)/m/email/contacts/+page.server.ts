import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Lists (route /m/email/contacts): lists of people who get your mail, with their subscription state. */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const lists = await emailPlatform().audience.listLists()
  return {
    lists: lists.map((l) => ({
      id: l.id,
      name: l.name,
      doubleOptIn: l.doubleOptIn,
      subscribed: l.subscribed,
      pending: l.pending,
      unsubscribed: l.unsubscribed,
    })),
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    const out = await act('create', async () => {
      const l = await emailPlatform().audience.createList(
        { name: field(form, 'name'), doubleOptIn: field(form, 'doubleOptIn') === 'on' },
        me.userId,
      )
      return { id: l.id }
    })
    if ('id' in out && typeof out.id === 'string')
      throw redirect(303, `/m/email/contacts/${out.id}`)
    return out
  },
}
