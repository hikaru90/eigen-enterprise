import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import {
  EmailPlatformError,
  emailPlatform,
} from '../../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../../access.server'

/**
 * One sender domain: its DNS records with copy buttons and per-record status,
 * and the "Receive mail on this domain" switch. Before it is turned on, the
 * domain's current MX records are looked up so the warning can name them.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
  const me = await requireMember(locals)
  const platform = emailPlatform()
  const d = await platform.getDomain(params.id)
  if (!d) error(404, 'No such domain')
  let currentMx: Array<{ exchange: string; priority: number }> = []
  let mxError: string | null = null
  if (me.isAdmin && d.sendable && !d.receiving) {
    try {
      currentMx = await platform.currentMx(d.id)
    } catch (err) {
      if (!(err instanceof EmailPlatformError)) throw err
      mxError = err.message
    }
  }
  return {
    receiving: { on: d.receiving, currentMx, mxError },
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
    return act('recheck', async () => ({
      status: (await emailPlatform().recheckDomain(params.id)).status,
    }))
  },
  tracking: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const on = field(await request.formData(), 'tracking') === 'on'
    return act('tracking', async () => ({
      tracking: (await emailPlatform().setDomainTracking(params.id, on)).tracking,
    }))
  },
  /** "Receive mail on this domain": the first domain also sets receiving up at Amazon. */
  receiving: async ({ locals, params, request, url }) => {
    await requireAdmin(locals)
    const on = field(await request.formData(), 'receiving') === 'on'
    return act('receiving', async () => {
      const out = await emailPlatform().setDomainReceiving(params.id, on, url.origin)
      return { receiving: out.domain.receiving, receivingError: out.receivingError }
    })
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
