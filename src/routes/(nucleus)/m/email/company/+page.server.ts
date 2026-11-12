import type { MessageStatus } from '../../../../../../modules/email/platform/status'
import type { MessageRow } from '../../../../../../modules/email/platform/store'
import type { PageServerLoad } from './$types'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { requireAdmin } from '../access.server'

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
 * Email › Company mail (plan/email-inbox.md S6): what the company is sending —
 * waiting to go out and what was sent (system, agent, API, template and flow
 * mail; never a member's own webmail). It was the Email landing view until the
 * inbox arrived; now the owner and admins only (owner decision 2026-11-12).
 */
export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals)
  const platform = emailPlatform()
  if (!(await platform.owlery.settings())) return { connected: false, pending: [], sent: [] }
  const [pending, sent] = await Promise.all([
    platform.store.listMessages({ statuses: PENDING, limit: LIMIT }),
    platform.store.listMessages({ excludeStatuses: PENDING, limit: LIMIT }),
  ])
  return { connected: true, pending: pending.map(view), sent: sent.map(view) }
}
