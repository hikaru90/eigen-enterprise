import type { MailHeader } from '../owlery/ses'
import type { MessageStatus } from './status'
import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import {
  mailDomains,
  mailJobs,
  mailMessageEvents,
  mailMessages,
  mailSenders,
  mailSuppressions,
  type MailSource,
  type SuppressionReason,
} from '$lib/server/db/email.schema'
import { normalizeEmail } from './suppression'

/**
 * Postgres persistence for the email platform (tables of migration 0114+).
 * The one store behind domains, senders, the sent-mail log, suppressions and
 * the module's background jobs.
 */

export type DomainRow = typeof mailDomains.$inferSelect
export type SenderRow = typeof mailSenders.$inferSelect
export type MessageRow = typeof mailMessages.$inferSelect
export type MessageEventRow = typeof mailMessageEvents.$inferSelect
export type SuppressionRow = typeof mailSuppressions.$inferSelect
export type JobRow = typeof mailJobs.$inferSelect

export type NewMessage = {
  source: MailSource
  status: MessageStatus
  fromAddress: string
  toAddress: string
  replyTo?: string | null
  subject: string
  html: string | null
  text: string | null
  contentStored: boolean
  headers?: MailHeader[] | null
  apiKeyId?: string | null
  apiKeyName?: string | null
  templateId?: string | null
  contactId?: string | null
  flowId?: string | null
  scheduledAt?: Date | null
  error?: string | null
}

export type MessageListFilter = {
  status?: MessageStatus
  /** Matches recipient or subject (case-insensitive). */
  search?: string
  limit: number
  /** created_at of the last row on the previous page. */
  before?: Date
}

/** Who may appear in the From line: the sender's display name and its domain's tracking flag. */
export type SenderCheck =
  | { ok: true; displayName: string | null; tracking: boolean }
  | { ok: false; reason: string }

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

export class EmailStore {
  constructor(private readonly handle: DbHandle) {}

  private db(): Promise<AppDatabase> {
    return resolveDb(this.handle)
  }

  // ─── domains ───────────────────────────────────────────────────────────────

  async listDomains(): Promise<DomainRow[]> {
    return (await this.db()).select().from(mailDomains).orderBy(asc(mailDomains.createdAt))
  }

  async getDomain(id: string): Promise<DomainRow | null> {
    const [row] = await (await this.db()).select().from(mailDomains).where(eq(mailDomains.id, id)).limit(1)
    return row ?? null
  }

  async getDomainByName(name: string): Promise<DomainRow | null> {
    const [row] = await (await this.db()).select().from(mailDomains).where(eq(mailDomains.name, name)).limit(1)
    return row ?? null
  }

  async insertDomain(values: typeof mailDomains.$inferInsert): Promise<DomainRow> {
    const [row] = await (await this.db()).insert(mailDomains).values(values).returning()
    if (!row) throw new Error('mail_domains insert returned no row')
    return row
  }

  async updateDomain(id: string, patch: Partial<typeof mailDomains.$inferInsert>): Promise<DomainRow> {
    const [row] = await (await this.db())
      .update(mailDomains)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(mailDomains.id, id))
      .returning()
    if (!row) throw new Error(`mail_domains row ${id} vanished during update`)
    return row
  }

  async deleteDomain(id: string): Promise<void> {
    await (await this.db()).delete(mailDomains).where(eq(mailDomains.id, id))
  }

  async verifyingDomains(): Promise<DomainRow[]> {
    return (await this.db()).select().from(mailDomains).where(eq(mailDomains.isVerifying, true))
  }

  // ─── senders ───────────────────────────────────────────────────────────────

  async listSenders(): Promise<(SenderRow & { domainName: string | null; domainStatus: string | null })[]> {
    const rows = await (await this.db())
      .select({ sender: mailSenders, domainName: mailDomains.name, domainStatus: mailDomains.status })
      .from(mailSenders)
      .leftJoin(mailDomains, eq(mailSenders.domainId, mailDomains.id))
      .orderBy(asc(mailSenders.createdAt))
    return rows.map((r) => ({ ...r.sender, domainName: r.domainName, domainStatus: r.domainStatus }))
  }

  async getSender(id: string): Promise<SenderRow | null> {
    const [row] = await (await this.db()).select().from(mailSenders).where(eq(mailSenders.id, id)).limit(1)
    return row ?? null
  }

  async getSenderByAddress(address: string): Promise<SenderRow | null> {
    const [row] = await (await this.db())
      .select()
      .from(mailSenders)
      .where(eq(mailSenders.address, normalizeEmail(address)))
      .limit(1)
    return row ?? null
  }

  /** Inserts or renames a sender (the address is the identity). */
  async upsertSender(values: { address: string; displayName: string | null; domainId: string | null; createdBy: string }): Promise<SenderRow> {
    const address = normalizeEmail(values.address)
    const [row] = await (await this.db())
      .insert(mailSenders)
      .values({ ...values, address })
      .onConflictDoUpdate({ target: mailSenders.address, set: { displayName: values.displayName, domainId: values.domainId } })
      .returning()
    if (!row) throw new Error('mail_senders upsert returned no row')
    return row
  }

  async deleteSender(id: string): Promise<void> {
    await (await this.db()).delete(mailSenders).where(eq(mailSenders.id, id))
  }

  /**
   * May mail go out From this address? A registered sender on a verified domain
   * (or one Amazon verified on its own), or any address on a verified domain.
   */
  async checkSender(address: string): Promise<SenderCheck> {
    const addr = normalizeEmail(address)
    const domainName = addr.slice(addr.lastIndexOf('@') + 1)
    const sender = await this.getSenderByAddress(addr)
    const domain = await this.getDomainByName(domainName)
    if (domain && domain.status === 'SUCCESS') {
      return { ok: true, displayName: sender?.displayName ?? null, tracking: domain.tracking }
    }
    if (sender && sender.domainId === null) return { ok: true, displayName: sender.displayName, tracking: false }
    if (domain) return { ok: false, reason: `The domain ${domainName} is not verified yet. Finish its DNS records under Email › Domains.` }
    return { ok: false, reason: `${addr} is not one of your senders. Add its domain under Email › Domains first.` }
  }

  // ─── messages (the sent-mail log) ──────────────────────────────────────────

  async insertMessage(m: NewMessage): Promise<MessageRow> {
    const [row] = await (await this.db())
      .insert(mailMessages)
      .values({ ...m, toAddress: normalizeEmail(m.toAddress) })
      .returning()
    if (!row) throw new Error('mail_messages insert returned no row')
    return row
  }

  async updateMessage(id: string, patch: Partial<typeof mailMessages.$inferInsert>): Promise<MessageRow> {
    const [row] = await (await this.db())
      .update(mailMessages)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(mailMessages.id, id))
      .returning()
    if (!row) throw new Error(`mail_messages row ${id} vanished during update`)
    return row
  }

  async getMessage(id: string): Promise<MessageRow | null> {
    const [row] = await (await this.db()).select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1)
    return row ?? null
  }

  async findMessageBySesId(sesMessageId: string): Promise<MessageRow | null> {
    const [row] = await (await this.db())
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.sesMessageId, sesMessageId))
      .limit(1)
    return row ?? null
  }

  async listMessages(f: MessageListFilter): Promise<MessageRow[]> {
    const where = [
      ...(f.status ? [eq(mailMessages.status, f.status)] : []),
      ...(f.search
        ? [or(ilike(mailMessages.toAddress, `%${f.search}%`), ilike(mailMessages.subject, `%${f.search}%`))!]
        : []),
      ...(f.before ? [lt(mailMessages.createdAt, f.before)] : []),
    ]
    return (await this.db())
      .select()
      .from(mailMessages)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(mailMessages.createdAt))
      .limit(f.limit)
  }

  async countMessages(): Promise<{ total: number; byStatus: Record<string, number> }> {
    const rows = await (await this.db())
      .select({ status: mailMessages.status, n: count() })
      .from(mailMessages)
      .groupBy(mailMessages.status)
    const byStatus: Record<string, number> = {}
    let total = 0
    for (const r of rows) {
      byStatus[r.status] = r.n
      total += r.n
    }
    return { total, byStatus }
  }

  async addEvent(messageId: string, status: MessageStatus, detail: Record<string, unknown> | null, occurredAt = new Date()): Promise<void> {
    await (await this.db()).insert(mailMessageEvents).values({ messageId, status, detail, occurredAt })
  }

  async hasEvent(messageId: string, status: MessageStatus): Promise<boolean> {
    const [row] = await (await this.db())
      .select({ id: mailMessageEvents.id })
      .from(mailMessageEvents)
      .where(and(eq(mailMessageEvents.messageId, messageId), eq(mailMessageEvents.status, status)))
      .limit(1)
    return Boolean(row)
  }

  async events(messageId: string): Promise<MessageEventRow[]> {
    return (await this.db())
      .select()
      .from(mailMessageEvents)
      .where(eq(mailMessageEvents.messageId, messageId))
      .orderBy(asc(mailMessageEvents.occurredAt), asc(mailMessageEvents.createdAt))
  }

  // ─── suppressions ──────────────────────────────────────────────────────────

  async isSuppressed(email: string): Promise<boolean> {
    return (await this.suppressedAmong([email])).size > 0
  }

  async suppressedAmong(emails: string[]): Promise<Set<string>> {
    const norm = [...new Set(emails.map(normalizeEmail))]
    if (norm.length === 0) return new Set()
    const rows = await (await this.db())
      .select({ email: mailSuppressions.email })
      .from(mailSuppressions)
      .where(inArray(mailSuppressions.email, norm))
    return new Set(rows.map((r) => r.email))
  }

  async addSuppression(email: string, reason: SuppressionReason, source: string | null): Promise<SuppressionRow> {
    const values = { email: normalizeEmail(email), reason, source }
    const [row] = await (await this.db())
      .insert(mailSuppressions)
      .values(values)
      .onConflictDoUpdate({ target: mailSuppressions.email, set: { reason, source, updatedAt: new Date() } })
      .returning()
    if (!row) throw new Error('mail_suppressions upsert returned no row')
    return row
  }

  async removeSuppression(email: string): Promise<boolean> {
    const rows = await (await this.db())
      .delete(mailSuppressions)
      .where(eq(mailSuppressions.email, normalizeEmail(email)))
      .returning({ id: mailSuppressions.id })
    return rows.length > 0
  }

  async listSuppressions(search?: string): Promise<SuppressionRow[]> {
    return (await this.db())
      .select()
      .from(mailSuppressions)
      .where(search ? ilike(mailSuppressions.email, `%${search}%`) : undefined)
      .orderBy(desc(mailSuppressions.createdAt))
      .limit(500)
  }

  /** Deletes every row of the platform tables — only the e2e harness reset calls this. */
  async clearAll(): Promise<void> {
    const db = await this.db()
    for (const t of EMAIL_PLATFORM_TABLES) await db.delete(t)
  }

  // ─── background jobs ───────────────────────────────────────────────────────

  async enqueueJob(kind: string, payload: Record<string, unknown>, runAt: Date, dedupeKey?: string): Promise<void> {
    await (await this.db())
      .insert(mailJobs)
      .values({ kind, payload, runAt, dedupeKey: dedupeKey ?? null })
      .onConflictDoNothing()
  }

  async cancelJobs(dedupeKey: string): Promise<void> {
    await (await this.db())
      .update(mailJobs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(mailJobs.dedupeKey, dedupeKey), eq(mailJobs.status, 'pending')))
  }

  /** Claims due jobs atomically (one statement, SKIP LOCKED) so two ticks never run the same job. */
  async claimDueJobs(limit: number, now = new Date()): Promise<JobRow[]> {
    const db = await this.db()
    const claimed = await db.execute<{ id: string }>(sql`
      UPDATE mail_jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
      WHERE id IN (
        SELECT id FROM mail_jobs WHERE status = 'pending' AND run_at <= ${now.toISOString()}::timestamptz
        ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
      )
      RETURNING id`)
    const ids = [...claimed].map((r) => r.id)
    if (ids.length === 0) return []
    return db.select().from(mailJobs).where(inArray(mailJobs.id, ids)).orderBy(asc(mailJobs.runAt))
  }

  async finishJob(id: string): Promise<void> {
    await (await this.db()).update(mailJobs).set({ status: 'done', updatedAt: new Date() }).where(eq(mailJobs.id, id))
  }

  /** Retries with backoff until max_attempts, then marks the job failed (kept, with its error). */
  async failJob(job: JobRow, error: string, now = new Date()): Promise<void> {
    const terminal = job.attempts >= job.maxAttempts
    const backoffMs = Math.min(3_600_000, 60_000 * 2 ** Math.max(0, job.attempts - 1))
    await (await this.db())
      .update(mailJobs)
      .set({
        status: terminal ? 'failed' : 'pending',
        lastError: error,
        runAt: terminal ? job.runAt : new Date(now.getTime() + backoffMs),
        updatedAt: new Date(),
      })
      .where(eq(mailJobs.id, job.id))
  }
}

/** Every email-platform table, children first (the e2e harness reset under MAIL_TRANSPORT=fake). */
export const EMAIL_PLATFORM_TABLES = [
  mailMessageEvents,
  mailMessages,
  mailSenders,
  mailDomains,
  mailSuppressions,
  mailJobs,
] as const

export function defaultEmailStore(): EmailStore {
  return new EmailStore(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  })
}
