import type { Actions, PageServerLoad } from './$types'
import { fail } from '@sveltejs/kit'
import { KernelError } from '$lib/kernel/errors'
import { requireAdmin } from '$lib/server/auth/require-admin'
import { SubstrateError, type EeStatus } from '$lib/server/ee/client'
import { ownerRun } from '$lib/server/website/owner-run'

/**
 * /m/website/site: the company site's public domain (D-W1 — exactly one
 * synthesized site per company). The domain is the owner's click, so every
 * change runs through substrate tools as the signed-in human (D11).
 */

type Status = ({ managed: true } & EeStatus) | { managed: false; reason: string }

export type SiteData = {
  managed: boolean
  reason: string | null
  publicHost: string | null
  /** Its own domain when it has one; otherwise the console's address. */
  siteUrl: string | null
}

export const load: PageServerLoad = async (event): Promise<SiteData> => {
  const user = await requireAdmin(event.locals.user)
  const status = await ownerRun<Status>(user, 'substrate.status', {})
  if (!status.managed)
    return { managed: false, reason: status.reason, publicHost: null, siteUrl: null }
  const publicHost = status.settings.publicHost
  return {
    managed: true,
    reason: null,
    publicHost,
    siteUrl: publicHost ? `https://${publicHost}` : `https://${status.settings.consoleHost}`,
  }
}

/** code ↔ owner: a plain sentence for the page; details go to the server log. */
function plainDomainMessage(err: unknown): string {
  if (err instanceof SubstrateError) return err.message
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return 'Only an admin can do this.'
    if (err.code === 'invalid_input')
      return 'That is not a valid domain name. Check it and try again.'
    if (err.code === 'approval_required') return 'This is waiting for your approval in the chat.'
  }
  return 'Something went wrong while changing the domain. Try again; if it keeps happening, ask in the chat.'
}

function logSiteFailure(action: string, err: unknown): void {
  const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : ''
  console.error(
    `[website/site] ${action} failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
  )
}

export const actions: Actions = {
  /**
   * ee replaces the public host and its route atomically in domain_add.
   * Never delete first: validation and daemon failures must leave the old host intact.
   */
  domainSet: async (event) => {
    const user = await requireAdmin(event.locals.user)
    // Lowercased up front so what we echo is what ee stores (its schema does the same).
    const host = String((await event.request.formData()).get('host') ?? '')
      .trim()
      .toLowerCase()
    try {
      const status = await ownerRun<Status>(user, 'substrate.status', {})
      if (!status.managed) {
        return fail(400, {
          action: 'domainSet' as const,
          error:
            "This EigenEnterprise copy runs without ee, the server's deploy agent, so it cannot give the site its own domain.",
        })
      }
      if (
        host === status.settings.consoleHost ||
        (host !== status.settings.publicHost && status.routes.some((route) => route.host === host))
      ) {
        return fail(400, {
          action: 'domainSet' as const,
          error: `${host} is already assigned to another route. Remove it from its current owner first.`,
        })
      }
      const out = await ownerRun<{ reconcileError: string | null }>(user, 'substrate.domain_add', {
        host,
        role: 'public',
        workload: 'os',
      })
      return {
        action: 'domainSet' as const,
        ok: true,
        host,
        ...(out.reconcileError ? { reconcileError: out.reconcileError } : {}),
      }
    } catch (err) {
      logSiteFailure('domainSet', err)
      return fail(400, { action: 'domainSet' as const, error: plainDomainMessage(err) })
    }
  },
  domainRemove: async (event) => {
    const user = await requireAdmin(event.locals.user)
    const host = String((await event.request.formData()).get('host') ?? '').trim()
    try {
      await ownerRun(user, 'substrate.domain_remove', { host })
      return { action: 'domainRemove' as const, ok: true }
    } catch (err) {
      logSiteFailure('domainRemove', err)
      return fail(400, { action: 'domainRemove' as const, error: plainDomainMessage(err) })
    }
  },
}
