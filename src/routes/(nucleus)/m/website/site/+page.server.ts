import type { PageServerLoad } from './$types'
import type { Address } from '$lib/domains/host-status'
import type { ErrorReport } from '$lib/errors/agent-report'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { addressesShowing } from '$lib/server/domains/addresses'
import type { EeStatus } from '$lib/server/ee/client'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * /m/website/site: the company site's public address (D-W1 — exactly one
 * synthesized site per company). Domains are a global setting edited only in
 * Settings › Domains (plan/domains-one-claim.md, D5): this page shows the
 * site's address(es) with their status and links there; it has no domain
 * field of its own any more.
 */

type Status = ({ managed: true } & EeStatus) | { managed: false; reason: string }

export type SiteData = {
  managed: boolean
  reason: string | null
  publicHost: string | null
  /** Its own domain when it has one; otherwise the console's address. */
  siteUrl: string | null
  /** The hostnames that show the company website, with their status. */
  addresses: Address[]
  addressesError: ErrorReport | null
}

export const load: PageServerLoad = async (event): Promise<SiteData> => {
  const user = await requireAdmin(event.locals.user)
  const status = await ownerRun<Status>(user, 'substrate.status', {})
  if (!status.managed)
    return {
      managed: false,
      reason: status.reason,
      publicHost: null,
      siteUrl: null,
      addresses: [],
      addressesError: null,
    }
  const publicHost = status.settings.publicHost
  const { addresses, addressesError } = await addressesShowing(
    user,
    'the company website',
    (shows) => shows.kind === 'site',
  )
  return {
    managed: true,
    reason: null,
    publicHost,
    siteUrl: publicHost ? `https://${publicHost}` : `https://${status.settings.consoleHost}`,
    addresses,
    addressesError,
  }
}
