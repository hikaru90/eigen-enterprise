import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import type { ErrorReport } from '$lib/errors/agent-report'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import {
  EmailPlatformError,
  emailPlatform,
} from '../../../../../../../modules/email/platform/service'
import { act, field, receivingReport, requireAdmin, requireMember } from '../../access.server'

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
  let mxError: ErrorReport | null = null
  if (me.isAdmin && d.sendable && !d.receiving) {
    try {
      currentMx = await platform.currentMx(d.id)
    } catch (err) {
      if (!(err instanceof EmailPlatformError)) throw err
      mxError = errorReport(err, {
        attempted: `Looking up the current MX records of ${d.name}`,
        input: { domain: d.name },
        plain: () => err.message,
      })
    }
  }
  return {
    receiving: { on: d.receiving, currentMx, mxError },
    // Amazon's stored reason the domain failed verification (EmailPlatform.recheckDomain writes it).
    domainError: d.errorMessage
      ? refusalReport(d.errorMessage, {
          attempted: `Verifying the sending domain ${d.name} at Amazon SES`,
          input: { domain: d.name, region: d.region, status: d.status },
          cause: d.errorMessage,
          nextSteps: [
            'This is the reason Amazon SES gave for the domain, stored on the domain row by the DNS re-check (modules/email/platform/service.ts). Compare the DNS records on the page with what is published (dig TXT/CNAME), then Re-check now.',
          ],
        })
      : null,
    domain: {
      id: d.id,
      name: d.name,
      region: d.region,
      status: d.status,
      sendable: d.sendable,
      tracking: d.tracking,
      isVerifying: d.isVerifying,
      adopted: d.adopted,
      lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
      records: d.records,
    },
  }
}

export const actions: Actions = {
  recheck: async ({ locals, params }) => {
    await requireAdmin(locals)
    return act('recheck', 'Rechecking a sending domain’s DNS', async () => ({
      status: (await emailPlatform().recheckDomain(params.id)).status,
    }))
  },
  tracking: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const on = field(await request.formData(), 'tracking') === 'on'
    return act('tracking', 'Changing open and click tracking for a domain', async () => ({
      tracking: (await emailPlatform().setDomainTracking(params.id, on)).tracking,
    }))
  },
  /** "Receive mail on this domain": the first domain also sets receiving up at Amazon. */
  receiving: async ({ locals, params, request, url }) => {
    await requireAdmin(locals)
    const on = field(await request.formData(), 'receiving') === 'on'
    return act('receiving', 'Switching receiving mail on or off for a domain', async () => {
      const out = await emailPlatform().setDomainReceiving(params.id, on, url.origin)
      return {
        receiving: out.domain.receiving,
        receivingError: receivingReport(
          out.receivingError,
          'Setting up receiving mail at Amazon SES for a domain',
        ),
      }
    })
  },
  delete: async ({ locals, params }) => {
    await requireAdmin(locals)
    const out = await act('delete', 'Removing a sending domain', async () => {
      await emailPlatform().deleteDomain(params.id)
      return {}
    })
    if ('ok' in out && out.ok === true) throw redirect(303, '/m/email/setup')
    return out
  },
}
