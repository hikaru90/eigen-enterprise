import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { BoughtDomain } from '$lib/domains/contract'
import type { MemberRole } from '$lib/server/auth/roles'
import { domainsGuard, type DomainsEvent } from '$lib/server/domains/http'

/**
 * The Email act on a managed box (plan/managed-domains.md, "Email: Your sender
 * address"): eigenEnterprise Mail needs no keys, so the owner only picks the
 * address on the company's domain. It becomes the default sender (sign-in
 * codes go out from it).
 *
 * The domain must be one of the company's: a mail domain already, or one it
 * bought through eigenEnterprise that is on its way (DM5 makes it a mail
 * domain as soon as the control plane configures it). Mail from it works once
 * Amazon has verified the domain; until then a send fails loud, as on the
 * Email page.
 *
 *   POST /api/onboarding/sender { address } → { ok, address, ready }
 */

export type ManagedSenderDeps = {
  role: (userId: string) => Promise<MemberRole | null>
  mode: () => Promise<'own' | 'managed' | null>
  mailDomains: () => Promise<{ name: string; sendable: boolean }[]>
  /** The company's bought domains; null on a box that can't buy. */
  bought: (() => Promise<BoughtDomain[]>) | null
  setDefaultSender: (address: string, by: string) => Promise<void>
}

const address = z.string().trim().toLowerCase().pipe(z.email('Enter an address like hello@yourcompany.com.'))

export function managedSenderRoute(deps: ManagedSenderDeps) {
  return async (event: DomainsEvent): Promise<Response> => {
    const who = await domainsGuard(event.locals, deps.role)
    if (who instanceof Response) return who
    if ((await deps.mode()) !== 'managed') {
      return json({ error: 'This server sends with your own Amazon SES: connect it with the Amazon SES form.' }, { status: 400 })
    }
    let raw: unknown
    try {
      raw = ((await event.request.json()) as { address?: unknown })?.address
    } catch {
      return json({ error: 'Request body must be JSON.' }, { status: 400 })
    }
    const parsed = address.safeParse(raw)
    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'Enter an email address.' }, { status: 400 })
    const addr = parsed.data
    const domain = addr.slice(addr.lastIndexOf('@') + 1)
    const mail = (await deps.mailDomains()).find((d) => d.name === domain)
    let ready = mail?.sendable ?? false
    if (!mail) {
      let bought: BoughtDomain[]
      try {
        bought = deps.bought ? await deps.bought() : []
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
      }
      const ours = bought.find((d) => d.name === domain && d.state !== 'failed')
      if (!ours) {
        return json(
          { error: `${domain} is not one of the company’s domains yet. Go back and buy or connect it first.` },
          { status: 400 },
        )
      }
      ready = false
    }
    await deps.setDefaultSender(addr, who.userId)
    return json({ ok: true, address: addr, ready })
  }
}
