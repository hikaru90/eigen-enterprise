import type { PageServerLoad } from './$types'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import {
  MESSAGE_STATUSES,
  type MessageStatus,
} from '../../../../../../modules/email/platform/status'
import { requireMember } from '../access.server'

const PAGE = 50

/** Email › Logs: every mail the company sent, newest first, filterable by status and recipient/subject. */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireMember(locals)
  const rawStatus = url.searchParams.get('status') ?? ''
  const status = (MESSAGE_STATUSES as readonly string[]).includes(rawStatus)
    ? (rawStatus as MessageStatus)
    : undefined
  const search = url.searchParams.get('q')?.trim() || undefined
  const beforeRaw = url.searchParams.get('before')
  const before = beforeRaw && !Number.isNaN(Date.parse(beforeRaw)) ? new Date(beforeRaw) : undefined
  const rows = await emailPlatform().store.listMessages({ status, search, before, limit: PAGE + 1 })
  const page = rows.slice(0, PAGE)
  return {
    filter: { status: status ?? '', q: search ?? '' },
    messages: page.map((m) => ({
      id: m.id,
      to: m.toAddress,
      from: m.fromAddress,
      subject: m.subject,
      status: m.status,
      source: m.source,
      apiKeyName: m.apiKeyName,
      createdAt: m.createdAt.toISOString(),
      scheduledAt: m.scheduledAt?.toISOString() ?? null,
    })),
    older: rows.length > PAGE ? page[page.length - 1]!.createdAt.toISOString() : null,
  }
}
