import type { PageServerLoad } from './$types'
import type { BoughtDomain } from '$lib/domains/contract'
import { domainRows } from '$lib/domains/rows'
import type { ErrorReport } from '$lib/errors/agent-report'
import { requireCapability } from '$lib/server/auth/require-capability'
import { DomainsApiError, domainsClient } from '$lib/server/domains/client'
import { domainsFromEnv } from '$lib/server/domains/env'
import { registrantDefaults } from '$lib/server/domains/registrant-defaults'
import { errorReport } from '$lib/server/errors/report'
import { emailPlatform } from '../../../../../modules/email/platform/service'

/**
 * Settings › Domains (plan/managed-domains.md): the company's domains — the
 * ones bought through eigenEnterprise (state, renewal) and the ones connected
 * from its own DNS — with "Buy a domain" (managed boxes) and "Connect one you
 * have", the same components as the onboarding's Domain act. Owner and admins
 * (`company.manage`, like the company's name).
 */

const REASON = 'Only the owner or an admin manages the company’s domains.'

export const load: PageServerLoad = async ({ locals }) => {
  const { user } = await requireCapability(locals, 'company.manage', REASON)
  const config = domainsFromEnv()
  const platform = emailPlatform()
  let bought: BoughtDomain[] = []
  let boughtError: ErrorReport | null = null
  if (config) {
    try {
      bought = await domainsClient(config).list()
    } catch (err) {
      if (!(err instanceof DomainsApiError)) throw err
      boughtError = errorReport(err, {
        attempted: 'Listing the domains bought through eigenEnterprise (Settings › Domains)',
        plain: () => err.message,
        nextSteps: [
          'The list comes from the control plane (EE_DOMAINS_API_BASE); check its health and its logs for this box’s token at the time above.',
        ],
      })
    }
  }
  const [mail, mode] = await Promise.all([platform.listDomains(), platform.owlery.mode()])
  return {
    canBuy: config !== null,
    boughtError,
    rows: domainRows(
      bought,
      mail.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status,
        sendable: d.sendable,
        receiving: d.receiving,
      })),
      mode,
    ),
    registrant: config ? await registrantDefaults(user) : null,
  }
}
