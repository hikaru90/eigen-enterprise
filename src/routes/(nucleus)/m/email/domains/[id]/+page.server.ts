import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../../access.server'

/** One sender domain: its DNS records with copy buttons and per-record status. */
export const load: PageServerLoad = async ({ locals, params }) => {
  await requireMember(locals)
  const d = await emailPlatform().getDomain(params.id)
  if (!d) error(404, 'No such domain')
  return {
    domain: {
      id: d.id,
      name: d.name,
      region: d.region,
      status: d.status,
      sendable: d.sendable,
      tracking: d.tracking,
      isVerifying: d.isVerifying,
      errorMessage: d.errorMessage,
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
      records: d.records,
    },
  }
}

export const actions: Actions = {
  recheck: async ({ locals, params }) => {
    await requireAdmin(locals)
    return act('recheck', async () => ({ status: (await emailPlatform().recheckDomain(params.id)).status }))
  },
  tracking: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const on = field(await request.formData(), 'tracking') === 'on'
    return act('tracking', async () => ({ tracking: (await emailPlatform().setDomainTracking(params.id, on)).tracking }))
  },
  delete: async ({ locals, params }) => {
    await requireAdmin(locals)
    const out = await act('delete', async () => {
      await emailPlatform().deleteDomain(params.id)
      return {}
    })
    if ('ok' in out && out.ok === true) throw redirect(303, '/m/email/domains')
    return out
  },
}
