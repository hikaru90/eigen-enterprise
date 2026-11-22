import type { RequestEvent } from '@sveltejs/kit'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { showsOf } from '$lib/server/domains/targets'
import type { EeStatus } from '$lib/server/ee/client'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * /m/website/hosting: this server, read-only (D-W3). Domains are listed and
 * linked to whatever owns them — a domain's role is structural, never guessed
 * from text: what each host shows is the domains rule's answer (showsOf: the
 * console, the site, calls — rtc.<console host> — or an app). Domains are
 * changed on the app or site that owns them (D-W2), never here.
 */

type Status = ({ managed: true } & EeStatus) | { managed: false; reason: string }

export type HostingDomainRow = {
  host: string
  url: string
  role: 'Console' | 'Site' | 'Calls' | 'App'
  owner:
    | { kind: 'console' }
    | { kind: 'calls' }
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
    const shows = showsOf(status, route.host)
    switch (shows.kind) {
      case 'console':
        return { host: route.host, url, role: 'Console', owner: { kind: 'console' } }
      case 'site':
        return {
          host: route.host,
          url,
          role: 'Site',
          owner: { kind: 'site', href: '/m/website/site' },
        }
      case 'calls':
        // The calls (signalling) host: no page of its own, never an app link.
        return { host: route.host, url, role: 'Calls', owner: { kind: 'calls' } }
      case 'app':
        return {
          host: route.host,
          url,
          role: 'App',
          owner: { kind: 'app', name: shows.app, href: `/m/website/apps/${shows.app}` },
        }
      case 'nothing':
        throw new Error(`ee lists a route for ${route.host} that shows nothing`)
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
