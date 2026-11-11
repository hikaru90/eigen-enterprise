import type { PageServerLoad } from './$types'
import type { MessageRow } from '../../../../../modules/email/platform/store'
import type { MessageStatus } from '../../../../../modules/email/platform/status'
import { emailPlatform } from '../../../../../modules/email/platform/service'
import { requireMember } from './access.server'

/** Sends that have not left yet: waiting for their time, or in the send queue. */
const PENDING: MessageStatus[] = ['scheduled', 'queued']
const LIMIT = 10

const view = (m: MessageRow) => ({
  id: m.id,
  to: m.toAddress,
  subject: m.subject,
  status: m.status,
  source: m.source,
  scheduledAt: m.scheduledAt ? m.scheduledAt.toISOString() : null,
  createdAt: m.createdAt.toISOString(),
})

/**
 * Email › Mail, the landing view: the mail itself, not the setup — what is
 * waiting to go out and what was sent. The module stores outgoing mail only
 * (there is no inbound mail), so there is no inbox here.
 */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const platform = emailPlatform()
  if (!(await platform.owlery.settings())) return { connected: false, pending: [], sent: [] }
  const [pending, sent] = await Promise.all([
    platform.store.listMessages({ statuses: PENDING, limit: LIMIT }),
    platform.store.listMessages({ excludeStatuses: PENDING, limit: LIMIT }),
  ])
  return { connected: true, pending: pending.map(view), sent: sent.map(view) }
}
