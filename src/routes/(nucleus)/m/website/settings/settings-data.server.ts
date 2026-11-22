import type { RequestEvent } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { showsOf } from '$lib/server/domains/targets'
import type { EeStatus } from '$lib/server/ee/client'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * /m/website/settings: this server, read-only (D-W3). The domains themselves —
 * every hostname, what it shows, its DNS and certificate — are a global
 * setting in Settings › Domains (plan/domains-one-claim.md D5); this page
 * gives a short summary of what points here and links there. What each host
 * shows is the domains rule's answer (showsOf), never guessed from text.
 */

type Status = ({ managed: true } & EeStatus) | { managed: false; reason: string }

/** How many addresses point at this server, by what they show. */
export type HostingDomainSummary = {
  total: number
  console: number
  site: number
  apps: number
  calls: number
}

export type HostingData =
  | { managed: false; reason: string }
  | {
      managed: true
      server: {
        consoleHost: string
        consoleUrl: string
        siteHost: string | null
        appliedRev: string | null
        desiredRev: string
        lastReconcileError: string | null
      }
      domains: HostingDomainSummary
    }

export const loadWebsiteSettings = async (
  event: Pick<RequestEvent, 'locals'>,
): Promise<HostingData> => {
  const user = await requireAdmin(event.locals.user)
  const status = await ownerRun<Status>(user, 'substrate.status', {})
  if (!status.managed) return { managed: false, reason: status.reason }

  const { settings, routes } = status
  const domains: HostingDomainSummary = { total: 0, console: 0, site: 0, apps: 0, calls: 0 }
  for (const route of routes) {
    const shows = showsOf(status, route.host)
    if (shows.kind === 'nothing') continue
    domains.total++
    if (shows.kind === 'app') domains.apps++
    else domains[shows.kind]++
  }
  return {
    managed: true,
    server: {
      consoleHost: settings.consoleHost,
      consoleUrl: `https://${settings.consoleHost}`,
      siteHost: settings.publicHost,
      appliedRev: status.appliedRev,
      desiredRev: status.desiredRev,
      lastReconcileError: status.lastReconcileError,
    },
    domains,
  }
}
