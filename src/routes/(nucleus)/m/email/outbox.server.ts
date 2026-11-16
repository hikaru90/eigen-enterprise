import type { MailSource } from '$lib/server/db/email.schema'
import type { MessageStatus } from '../../../../../modules/email/platform/status'
import type { MessageRow } from '../../../../../modules/email/platform/store'
import { emailPlatform } from '../../../../../modules/email/platform/service'
import { requireAdmin } from './access.server'

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

export type OutboxRow = ReturnType<typeof view>

/**
 * What the company has waiting to go out and the last mail it sent, of one kind (owner and admins only — owner
 * decision 2026-11-12): transactional mail leaves out the marketing sources, marketing mail is only them. Never a
 * member's own webmail — those sends write no log row (plan/email-inbox.md).
 */
export async function loadOutbox(
  locals: App.Locals,
  kind: { sources: readonly MailSource[] } | { excludeSources: readonly MailSource[] },
): Promise<{ connected: boolean; pending: OutboxRow[]; sent: OutboxRow[] }> {
  await requireAdmin(locals)
  const platform = emailPlatform()
  if (!(await platform.owlery.settings())) return { connected: false, pending: [], sent: [] }
  const [pending, sent] = await Promise.all([
    platform.store.listMessages({ statuses: PENDING, ...kind, limit: LIMIT }),
    platform.store.listMessages({ excludeStatuses: PENDING, ...kind, limit: LIMIT }),
  ])
  return { connected: true, pending: pending.map(view), sent: sent.map(view) }
}
