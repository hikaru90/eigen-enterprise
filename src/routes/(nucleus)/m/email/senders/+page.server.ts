import type { Actions, PageServerLoad } from './$types'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Senders: named from-addresses on verified domains; one is the default. */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const platform = emailPlatform()
  if (!(await platform.owlery.isConfigured())) return { senders: [], domains: [] }
  const [senders, domains] = await Promise.all([platform.listSenders(), platform.listDomains()])
  return {
    senders: senders.map((s) => ({
      id: s.id,
      address: s.address,
      displayName: s.displayName,
      domainName: s.domainName,
      isDefault: s.isDefault,
    })),
    domains: domains.filter((d) => d.sendable).map((d) => d.name),
  }
}

export const actions: Actions = {
  add: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('add', async () => {
      const s = await emailPlatform().addSender(
        { address: field(form, 'address'), displayName: field(form, 'displayName') || null },
        me.userId,
      )
      return { address: s.address }
    })
  },
  makeDefault: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const id = field(await request.formData(), 'id')
    return act('makeDefault', async () => {
      await emailPlatform().setDefaultSender(id, me.userId)
      return {}
    })
  },
  remove: async ({ locals, request }) => {
    await requireAdmin(locals)
    const id = field(await request.formData(), 'id')
    return act('remove', async () => {
      await emailPlatform().deleteSender(id)
      return {}
    })
  },
}
