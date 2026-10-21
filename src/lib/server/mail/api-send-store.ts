import { and, eq, lt } from 'drizzle-orm'
import { moduleSource } from '$lib/kernel/cloudevents'
import { emitKernelEvent } from '$lib/kernel/events'
import { appKernel } from '$lib/server/boot'
import { getDb } from '$lib/server/db'
import { mailApiSend } from '$lib/server/db/mail-api.schema'
import { userApiKey } from '$lib/server/db/schema'
import { companyMail } from '.'
import { createMemoryRateLimiter, type MailSendDeps, type MailSendStore } from './api-send'

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000

/** Idempotency rows live in Postgres (mail_api_send) so a retry after a restart still never sends twice. */
export function dbMailSendStore(): MailSendStore {
  return {
    async canSendMail(keyId) {
      const [row] = await getDb()
        .select({ mailSend: userApiKey.mailSend })
        .from(userApiKey)
        .where(and(eq(userApiKey.id, keyId), eq(userApiKey.isActive, true)))
        .limit(1)
      return row?.mailSend === true
    },
    async claim({ keyId, idempotencyKey, bodyHash, to }) {
      const db = getDb()
      await db
        .delete(mailApiSend)
        .where(
          and(
            eq(mailApiSend.keyId, keyId),
            eq(mailApiSend.idempotencyKey, idempotencyKey),
            lt(mailApiSend.createdAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS)),
          ),
        )
      const [inserted] = await db
        .insert(mailApiSend)
        .values({ keyId, idempotencyKey, bodyHash, recipient: to, status: 'pending' })
        .onConflictDoNothing()
        .returning({ id: mailApiSend.id })
      if (inserted) return { kind: 'claimed', id: inserted.id }
      const [existing] = await db
        .select({ id: mailApiSend.id, bodyHash: mailApiSend.bodyHash, status: mailApiSend.status })
        .from(mailApiSend)
        .where(and(eq(mailApiSend.keyId, keyId), eq(mailApiSend.idempotencyKey, idempotencyKey)))
        .limit(1)
      if (!existing) throw new Error('mail_api_send: conflicting row vanished during claim')
      return { kind: 'existing', ...existing }
    },
    async markSent(id, messageId) {
      await getDb()
        .update(mailApiSend)
        .set({ status: 'sent', messageId })
        .where(eq(mailApiSend.id, id))
    },
    async release(id) {
      await getDb().delete(mailApiSend).where(eq(mailApiSend.id, id))
    },
  }
}

/** 60 mails per key per minute (in-memory; see createMemoryRateLimiter). */
const limiter = createMemoryRateLimiter({ limit: 60, windowMs: 60_000 })

export function mailSendDeps(principalId: string): MailSendDeps {
  return {
    mail: companyMail(),
    store: dbMailSendStore(),
    limiter,
    newId: () => crypto.randomUUID(),
    // Shown in Overview recent activity as a tool.executed write.
    async audit(entry) {
      const kernel = await appKernel()
      await emitKernelEvent(kernel.eventSink, {
        type: 'tool.executed',
        principalId,
        source: moduleSource('email'),
        payload: { tool: 'email.api_send', auditClass: 'write', ...entry },
      })
    },
  }
}
