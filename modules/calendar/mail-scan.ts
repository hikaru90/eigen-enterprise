import type { ScanOutcome } from './proposals'
import { isLlmNotConfiguredError } from '$lib/server/llm/errors'

/**
 * When a mail is read for an appointment (K7), off the request path: the
 * inbox ingest tells us a row was stored; a mail in the Inbox folder of a
 * personal mailbox queues one job for its holder (deduped per mail); the job
 * queue runs it later. Both ends do nothing while the Calendar plugin is
 * switched off (owner, 2026-11-12: off means off — no background work).
 */

export const CALENDAR_MAIL_PROPOSAL_JOB = 'calendar_mail_proposal' as const
export const SCAN_WORK = 'reading received mail for appointments'

export type StoredMailRef = {
  messageId: string
  mailbox: { id: string; kind: 'personal' | 'shared'; ownerUserId: string | null }
  folder: string
}

export type QueueDeps = {
  pluginOn: (pluginId: string, work: string) => Promise<boolean>
  enqueue: (job: { userId: string; dedupeKey: string; payload: { messageId: string } }) => Promise<void>
}

/** Whose appointment reading a stored mail is: the holder of a personal mailbox, for mail in its Inbox (not spam, not sent). */
export function scanHolder(mail: StoredMailRef): string | null {
  if (mail.mailbox.kind !== 'personal' || mail.mailbox.ownerUserId === null) return null
  return mail.folder === 'inbox' ? mail.mailbox.ownerUserId : null
}

export async function queueScan(d: QueueDeps, mail: StoredMailRef): Promise<boolean> {
  const userId = scanHolder(mail)
  if (userId === null) return false
  if (!(await d.pluginOn('calendar', SCAN_WORK))) return false
  await d.enqueue({ userId, dedupeKey: `calendar-proposal:${mail.messageId}`, payload: { messageId: mail.messageId } })
  return true
}

export type JobDeps = {
  pluginOn: (pluginId: string, work: string) => Promise<boolean>
  scan: (job: { userId: string; messageId: string }) => Promise<ScanOutcome>
  log: (line: string, fields: Record<string, string>) => void
}

export type JobOutcome = ScanOutcome | 'plugin_off' | 'no_provider'

/**
 * One queued reading. A malformed payload fails loud. No company AI provider
 * is not retried: the job completes with one log line (the reading needs the
 * provider; nothing else is lost). Anything else throws, so the queue retries.
 */
export async function runScanJob(d: JobDeps, job: { userId: string; payload: Record<string, unknown> }): Promise<JobOutcome> {
  const messageId = job.payload.messageId
  if (typeof messageId !== 'string' || messageId === '') throw new Error('calendar_mail_proposal job without a messageId')
  if (!(await d.pluginOn('calendar', SCAN_WORK))) return 'plugin_off'
  try {
    return await d.scan({ userId: job.userId, messageId })
  } catch (err) {
    if (isLlmNotConfiguredError(err)) {
      d.log('[calendar] no company AI provider: a received mail was not read for appointments', { messageId })
      return 'no_provider'
    }
    throw err
  }
}
