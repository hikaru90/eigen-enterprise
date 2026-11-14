import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { MailSetupError } from '$lib/server/mail/company-mail'
import { receivingIamPolicy } from '../../../../../../modules/email/owlery/receiving'
import { describeSesError } from '../../../../../../modules/email/owlery/ses'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Statuses that prove a mail actually left (the "send a test email" step is done). */
const LEFT = [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'delivery_delayed',
  'bounced',
  'complained',
  'rejected',
]

/**
 * Email › Setup › Account (moved from the Email landing page): where things stand and the next step, always actionable —
 * connect Amazon SES, add a domain, publish its DNS records, send a test.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const me = await requireMember(locals)
  const platform = emailPlatform()
  const settings = await platform.owlery.settings()
  if (!settings) {
    return {
      me: { email: me.email },
      account: null,
      domains: [],
      suggestedDomain: null,
      senders: [],
      counts: { total: 0, byStatus: {} as Record<string, number> },
      sentAny: false,
      recent: [],
    }
  }
  let sandbox: boolean | null = null
  let accountError: string | null = null
  try {
    sandbox = await (await platform.owlery.ses()).ses.isSandbox()
  } catch (err) {
    accountError = describeSesError(err)
  }
  const [domains, senders, counts, recent, receiving] = await Promise.all([
    platform.listDomains(),
    platform.listSenders(),
    platform.store.countMessages(),
    platform.store.listMessages({ limit: 5 }),
    platform.receivingState(),
  ])
  return {
    me: { email: me.email },
    account: {
      region: settings.region,
      sender: settings.emailFrom,
      sandbox,
      accountError,
      events: {
        status: settings.eventsStatus,
        error: settings.eventsError,
        callbackUrl: settings.eventsCallbackUrl,
      },
      receiving: receiving
        ? {
            status: receiving.receivingStatus,
            error: receiving.receivingError,
            callbackUrl: receiving.receivingCallbackUrl,
            bucket: receiving.receivingBucket,
            ruleSet: receiving.receivingRuleSet,
            iamPolicy: JSON.stringify(receivingIamPolicy(receiving.policyBucket), null, 2),
            domains: domains
              .filter((d) => d.receiving)
              .map((d) => ({
                id: d.id,
                name: d.name,
                mx: d.records.find((r) => r.purpose === 'inbound_mx')?.status ?? 'NOT_STARTED',
              })),
          }
        : null,
    },
    domains: domains.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      sendable: d.sendable,
      adopted: d.adopted,
      tracking: d.tracking,
      receiving: d.receiving,
      recordsDone: d.records.filter((r) => r.required && r.status === 'SUCCESS').length,
      recordsRequired: d.records.filter((r) => r.required).length,
    })),
    // The default sender's domain, until it is added: the obvious first domain.
    suggestedDomain: suggestDomain(settings.emailFrom, domains.map((d) => d.name)),
    senders: senders.map((s) => ({
      address: s.address,
      displayName: s.displayName,
      isDefault: s.isDefault,
    })),
    counts,
    sentAny: LEFT.some((s) => (counts.byStatus[s] ?? 0) > 0),
    recent: recent.map((m) => ({
      id: m.id,
      to: m.toAddress,
      subject: m.subject,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    })),
  }
}

/** The domain of the default sender, unless it (or a domain it sits under) is already added. */
function suggestDomain(sender: string, added: string[]): string | null {
  const at = sender.lastIndexOf('@')
  if (at < 0) return null
  const domain = sender.slice(at + 1).toLowerCase()
  return added.includes(domain) ? null : domain
}

export const actions: Actions = {
  /**
   * Adds a sender domain (moved here from the Domains tab, 2026-11-14). A domain the SES
   * account already has is adopted as it is; either way its DNS page opens next.
   */
  addDomain: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const name = field(await request.formData(), 'name')
    const out = await act('addDomain', async () => ({
      id: (await emailPlatform().addDomain(name, me.userId)).id,
    }))
    if ('id' in out && typeof out.id === 'string') throw redirect(303, `/m/email/domains/${out.id}`)
    return out
  },
  /** A real test email to the signed-in owner, from the chosen (or default) sender. */
  test: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const from = field(await request.formData(), 'from')
    return act('test', async () => {
      const out = await emailPlatform().owlery.send({
        to: me.email,
        ...(from ? { from } : {}),
        source: 'test',
        subject: 'Test email from your company',
        text: 'This is a test email from the Email page of eigenEnterprise. If you can read it, sending works.',
        html: '<p>This is a test email from the Email page of eigenEnterprise.</p><p>If you can read it, sending works.</p>',
      })
      if (out.status === 'suppressed') {
        throw new MailSetupError(
          `${me.email} is on the suppression list, so nothing was sent. Remove it under Suppression first.`,
        )
      }
      return { sentTo: me.email, id: out.id }
    })
  },
  /** "Set up receiving": bucket, topic, subscription, rule set and rules at Amazon (idempotent). */
  receiving: async ({ locals, url }) => {
    await requireAdmin(locals)
    return act('receiving', async () => ({
      receiving: (await emailPlatform().setupReceiving(url.origin)).receivingStatus,
    }))
  },
  /** Re-runs the delivery-event wiring (SNS topic, configuration sets, subscription). */
  events: async ({ locals, url }) => {
    await requireAdmin(locals)
    return act('events', async () => ({
      events: (await emailPlatform().owlery.setupEvents(url.origin)).eventsStatus,
    }))
  },
}
