import type { RequestEvent } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import type { EeStatus } from '$lib/server/ee/client'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * /m/website/hosting: this server, read-only (D-W3). Domains are listed and
 * linked to whatever owns them — a domain's role is structural, never guessed
 * from text: the console host is the Console, the site's public host is the
 * Site, anything else belongs to the route's workload (an App). Domains are
 * changed on the app or site that owns them (D-W2), never here.
 */

type Status = ({ managed: true } & EeStatus) | { managed: false; reason: string }

export type HostingDomainRow = {
  host: string
  url: string
  role: 'Console' | 'Site' | 'App'
  owner:
    | { kind: 'console' }
    | { kind: 'site'; href: '/m/website/site' }
    | { kind: 'app'; name: string; href: string }
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
      domains: HostingDomainRow[]
    }

export const loadWebsiteSettings = async (
  event: Pick<RequestEvent, 'locals'>,
): Promise<HostingData> => {
  const user = await requireAdmin(event.locals.user)
  const status = await ownerRun<Status>(user, 'substrate.status', {})
  if (!status.managed) return { managed: false, reason: status.reason }

  const { settings, routes } = status
  const domains = routes.map((route): HostingDomainRow => {
    const url = `https://${route.host}`
    if (route.host === settings.consoleHost) {
      return { host: route.host, url, role: 'Console', owner: { kind: 'console' } }
    }
    if (route.host === settings.publicHost) {
      return {
        host: route.host,
        url,
        role: 'Site',
        owner: { kind: 'site', href: '/m/website/site' },
      }
    }
    return {
      host: route.host,
      url,
      role: 'App',
      owner: { kind: 'app', name: route.workload, href: `/m/website/apps/${route.workload}` },
    }
  })
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
