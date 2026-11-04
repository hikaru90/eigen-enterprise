import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Domains: every sender domain and how far its DNS verification is. */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const platform = emailPlatform()
  if (!(await platform.owlery.isConfigured())) return { domains: [] }
  const domains = await platform.listDomains()
  return {
    domains: domains.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      sendable: d.sendable,
      tracking: d.tracking,
      recordsDone: d.records.filter((r) => r.required && r.status === 'SUCCESS').length,
      recordsRequired: d.records.filter((r) => r.required).length,
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    })),
  }
}

export const actions: Actions = {
  /** Registers the domain at Amazon (BYO-DKIM) and opens its DNS records. */
  add: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const name = field(await request.formData(), 'name')
    const out = await act('add', async () => ({ id: (await emailPlatform().addDomain(name, me.userId)).id }))
    if ('id' in out && typeof out.id === 'string') throw redirect(303, `/m/email/domains/${out.id}`)
    return out
  },
}
