import { json } from '@sveltejs/kit'
import type { ConnectedDomain } from '$lib/domains/connected'
import type { MemberRole } from '$lib/server/auth/roles'
import { domainsGuard, type DomainsEvent } from './http'

/**
 * "I already have one" (plan/managed-domains.md, the Domain act b, and
 * Settings › Domains): the domain becomes a mail domain at this company, and
 * the answer carries its DNS records for the existing records view. The
 * domain stays in the company's own DNS (DM4); nothing is written there.
 *
 *   POST /api/domains/connected            { name } → { domain }
 *   POST /api/domains/connected/<id>/check          → { domain }
 */

/** The email platform's DomainView, as far as the records view reads it. */
type DomainLike = Omit<ConnectedDomain, 'lastCheckedAt'> & { lastCheckedAt: Date | null }

export type ConnectHttpDeps = {
  role: (userId: string) => Promise<MemberRole | null>
  platform: {
    addDomain(name: string, createdBy: string): Promise<DomainLike>
    recheckDomain(id: string): Promise<DomainLike>
  }
  /** Errors already phrased for the person (EmailPlatformError, MailSetupError, MailNotConfiguredError). */
  explained: (err: unknown) => err is Error
}

/** Only what the records view needs. */
export function connectedView(d: DomainLike): ConnectedDomain {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    sendable: d.sendable,
    isVerifying: d.isVerifying,
    errorMessage: d.errorMessage,
    adopted: d.adopted,
    lastCheckedAt: d.lastCheckedAt?.toISOString() ?? null,
    records: d.records,
  }
}

export function connectRoutes(deps: ConnectHttpDeps) {
  const run = async (what: string, fn: () => Promise<DomainLike>): Promise<Response> => {
    try {
      return json({ domain: connectedView(await fn()) })
    } catch (err) {
      if (deps.explained(err)) return json({ error: err.message }, { status: 400 })
      console.error(`[domains] ${what} failed`, { error: err instanceof Error ? err.message : String(err) })
      return json({ error: `${what} failed unexpectedly. Try again in a moment.` }, { status: 500 })
    }
  }

  return {
    async add(event: DomainsEvent): Promise<Response> {
      const who = await domainsGuard(event.locals, deps.role)
      if (who instanceof Response) return who
      let name = ''
      try {
        const body = (await event.request.json()) as { name?: unknown }
        name = typeof body?.name === 'string' ? body.name : ''
      } catch {
        return json({ error: 'Request body must be JSON.' }, { status: 400 })
      }
      if (name.trim() === '') return json({ error: 'Enter your domain, like yourcompany.com.' }, { status: 400 })
      return run('Adding the domain', () => deps.platform.addDomain(name, who.userId))
    },

    async check(event: DomainsEvent, id: string): Promise<Response> {
      const who = await domainsGuard(event.locals, deps.role)
      if (who instanceof Response) return who
      return run('Checking the domain', () => deps.platform.recheckDomain(id))
    },
  }
}
