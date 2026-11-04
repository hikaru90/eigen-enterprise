import type { Actions, PageServerLoad } from './$types'
import { MailSetupError } from '$lib/server/mail/company-mail'
import { describeSesError } from '../../../../../modules/email/owlery/ses'
import { emailPlatform } from '../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from './access.server'

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
 * Email › Overview: where things stand and the next step, always actionable —
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
  const [domains, senders, counts, recent] = await Promise.all([
    platform.listDomains(),
    platform.listSenders(),
    platform.store.countMessages(),
    platform.store.listMessages({ limit: 5 }),
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
    },
    domains: domains.map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      sendable: d.sendable,
    })),
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

export const actions: Actions = {
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
  /** Re-runs the delivery-event wiring (SNS topic, configuration sets, subscription). */
  events: async ({ locals, url }) => {
    await requireAdmin(locals)
    return act('events', async () => ({
      events: (await emailPlatform().owlery.setupEvents(url.origin)).eventsStatus,
    }))
  },
}
