import type { IdentityInfo, SesApi, SesFactory, SesRawSendInput, SesSendInput } from './ses'
import type { SnsFactory } from './sns'
import { randomUUID } from 'node:crypto'
import { asc, eq, or, sql } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { mailFakeIdentities, mailFakeSent } from '$lib/server/db/mail-fake.schema'

/**
 * The fake mail transport for the RUNNING app (MAIL_TRANSPORT=fake). Same
 * behaviour as the unit-test FakeSes (identities start pending after creation,
 * the account is never in the sandbox, every send is captured) — but the state
 * lives in the database, so a restart or a second request still sees it and
 * Playwright reads it through /api/e2e/harness/mail.
 *
 * Why the database and not a file: it is the app's one durable store, already
 * present on the e2e harness and the test server, migration-checked, and shared
 * by every process of the install; the agent state dir belongs to the agent.
 */

/**
 * One captured mail. A raw send (the webmail) also carries `raw` (the MIME as
 * built) and `recipients` (the whole envelope, Bcc included); its `to` is the
 * first recipient, `subject` the raw mail's own Subject, html/text empty.
 */
export type CapturedMail = SesSendInput & { messageId: string; createdAt: string; raw?: string; recipients?: string[] }

/** What a raw send is captured as: the envelope and the bytes (MIME is 7-bit text once built). */
export function capturedRaw(input: SesRawSendInput, subject: string): SesSendInput & { raw: string; recipients: string[] } {
  const recipients = [...input.recipients.to, ...input.recipients.cc, ...input.recipients.bcc].map(norm)
  if (recipients.length === 0) throw new Error('a raw send needs at least one recipient')
  return { from: input.from, to: recipients[0]!, subject, html: '', text: '', raw: Buffer.from(input.raw).toString('utf8'), recipients }
}

/** The raw mail's decoded Subject (mailparser) — only for the capture's list view. */
async function rawSubject(raw: Uint8Array): Promise<string> {
  const { simpleParser } = await import('mailparser')
  return (await simpleParser(Buffer.from(raw))).subject ?? ''
}

export type FakeMailStore = {
  getIdentity(identity: string): Promise<IdentityInfo>
  /** Creates the identity as pending (unverified); a no-op when it already exists. */
  createIdentity(identity: string): Promise<void>
  /** Marks an identity verified (creating it if needed) — what clicking Amazon's link would do. */
  verifyIdentity(identity: string): Promise<void>
  deleteIdentity(identity: string): Promise<void>
  capture(mail: SesSendInput & { raw?: string; recipients?: string[] }): Promise<CapturedMail>
  /** Captured mails oldest first, optionally only those to one address (any envelope recipient of a raw send). */
  list(filter?: { to?: string }): Promise<CapturedMail[]>
  /** Forgets every captured mail and identity. */
  clear(): Promise<void>
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * SES backed by a FakeMailStore: what `owleryService()` uses under
 * MAIL_TRANSPORT=fake. Domains are identities too: created pending, verified
 * through the harness (POST /api/e2e/harness/mail { verify: <domain> }), which
 * flips DKIM, MAIL FROM and verification together. Configuration sets and the
 * account suppression list have no state worth faking.
 */
export function fakeStoreSes(store: FakeMailStore): SesFactory {
  return () => {
    const api: SesApi = {
      getIdentity: (id) => store.getIdentity(id),
      createIdentity: (id) => store.createIdentity(id),
      isSandbox: async () => false,
      send: async (input) => ({ messageId: (await store.capture(input)).messageId }),
      sendRaw: async (input) => ({ messageId: (await store.capture(capturedRaw(input, await rawSubject(input.raw)))).messageId }),
      createDomainIdentity: (input) => store.createIdentity(input.domain),
      getDomainIdentity: async (domain) => {
        const id = await store.getIdentity(domain)
        const s = !id.exists ? 'NOT_STARTED' : id.verified ? 'SUCCESS' : 'PENDING'
        return { exists: id.exists, verification: s, dkim: s, mailFrom: s, errorType: null }
      },
      deleteIdentity: (identity) => store.deleteIdentity(identity),
      ensureEventDestination: async () => {},
      removeFromAccountSuppression: async () => {},
    }
    return api
  }
}

/**
 * SNS for the fake transport: a topic name becomes a fake ARN and every
 * subscription counts as confirmed (no SNS exists to POST the confirmation).
 * Events reach the app through the harness instead (POST { sesEvent }).
 */
export const fakeSns: SnsFactory = (c) => ({
  createTopic: async (name) => `arn:aws:sns:${c.region}:000000000000:${name}`,
  subscribeHttps: async () => ({ confirmed: true }),
})

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

export class DbFakeMailStore implements FakeMailStore {
  constructor(private readonly db: DbHandle) {}

  async getIdentity(identity: string): Promise<IdentityInfo> {
    const [row] = await (await resolveDb(this.db))
      .select()
      .from(mailFakeIdentities)
      .where(eq(mailFakeIdentities.identity, norm(identity)))
      .limit(1)
    return row ? { exists: true, verified: row.verified } : { exists: false, verified: false }
  }

  async createIdentity(identity: string): Promise<void> {
    await (await resolveDb(this.db))
      .insert(mailFakeIdentities)
      .values({ identity: norm(identity), verified: false })
      .onConflictDoNothing()
  }

  async verifyIdentity(identity: string): Promise<void> {
    const values = { identity: norm(identity), verified: true, updatedAt: new Date() }
    await (await resolveDb(this.db))
      .insert(mailFakeIdentities)
      .values(values)
      .onConflictDoUpdate({ target: mailFakeIdentities.identity, set: values })
  }

  async deleteIdentity(identity: string): Promise<void> {
    await (await resolveDb(this.db)).delete(mailFakeIdentities).where(eq(mailFakeIdentities.identity, norm(identity)))
  }

  async capture(mail: SesSendInput & { raw?: string; recipients?: string[] }): Promise<CapturedMail> {
    const [row] = await (await resolveDb(this.db))
      .insert(mailFakeSent)
      .values({
        messageId: `fake-${randomUUID()}`,
        fromAddress: mail.from,
        toAddress: norm(mail.to),
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: mail.replyTo ?? null,
        headers: mail.headers ?? null,
        raw: mail.raw ?? null,
        recipients: mail.recipients ?? null,
      })
      .returning()
    if (!row) throw new Error('the fake mail transport could not store the mail')
    return toCaptured(row)
  }

  async list(filter: { to?: string } = {}): Promise<CapturedMail[]> {
    const db = await resolveDb(this.db)
    const base = db.select().from(mailFakeSent)
    const rows = filter.to
      ? await base
          .where(or(eq(mailFakeSent.toAddress, norm(filter.to)), sql`${mailFakeSent.recipients} @> ${JSON.stringify([norm(filter.to)])}::jsonb`))
          .orderBy(asc(mailFakeSent.createdAt))
      : await base.orderBy(asc(mailFakeSent.createdAt))
    return rows.map(toCaptured)
  }

  async clear(): Promise<void> {
    const db = await resolveDb(this.db)
    await db.delete(mailFakeSent)
    await db.delete(mailFakeIdentities)
  }
}

function toCaptured(row: typeof mailFakeSent.$inferSelect): CapturedMail {
  return {
    messageId: row.messageId,
    from: row.fromAddress,
    to: row.toAddress,
    subject: row.subject,
    html: row.html,
    text: row.text,
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    ...(row.headers ? { headers: row.headers } : {}),
    ...(row.raw !== null ? { raw: row.raw } : {}),
    ...(row.recipients ? { recipients: row.recipients } : {}),
    createdAt: row.createdAt.toISOString(),
  }
}

export function defaultFakeMailStore(): FakeMailStore {
  return new DbFakeMailStore(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  })
}

/** In-memory FakeMailStore for unit tests (same contract as the DB store). */
export class InMemoryFakeMailStore implements FakeMailStore {
  identities = new Map<string, boolean>()
  mails: CapturedMail[] = []
  private seq = 0

  async getIdentity(identity: string): Promise<IdentityInfo> {
    const v = this.identities.get(norm(identity))
    return v === undefined ? { exists: false, verified: false } : { exists: true, verified: v }
  }
  async createIdentity(identity: string) {
    if (!this.identities.has(norm(identity))) this.identities.set(norm(identity), false)
  }
  async verifyIdentity(identity: string) {
    this.identities.set(norm(identity), true)
  }
  async deleteIdentity(identity: string) {
    this.identities.delete(norm(identity))
  }
  async capture(mail: SesSendInput & { raw?: string; recipients?: string[] }) {
    this.seq += 1
    const captured: CapturedMail = { ...mail, to: norm(mail.to), messageId: `fake-${this.seq}`, createdAt: new Date(this.seq).toISOString() }
    this.mails.push(captured)
    return captured
  }
  async list(filter: { to?: string } = {}) {
    const to = filter.to ? norm(filter.to) : null
    return to ? this.mails.filter((m) => m.to === to || (m.recipients ?? []).includes(to)) : [...this.mails]
  }
  async clear() {
    this.mails = []
    this.identities.clear()
  }
}
