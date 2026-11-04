import type { MailLog } from '../owlery/service'
import type { MessageStatus } from './status'
import type { MessageRow, NewMessage, SenderCheck } from './store'
import { normalizeEmail } from './suppression'

/** In-memory MailLog for unit tests (the running app uses EmailStore). */
export class InMemoryMailLog implements MailLog {
  messages: MessageRow[] = []
  events: { messageId: string; status: MessageStatus; detail: Record<string, unknown> | null }[] = []
  jobs: { kind: string; payload: Record<string, unknown>; runAt: Date; dedupeKey?: string }[] = []
  suppressed = new Set<string>()
  /** address → check result; unknown addresses are refused like an unverified domain. */
  senders = new Map<string, SenderCheck>()
  private seq = 0

  async checkSender(address: string): Promise<SenderCheck> {
    return this.senders.get(normalizeEmail(address)) ?? { ok: false, reason: `${address} is not one of your senders.` }
  }

  async isSuppressed(email: string): Promise<boolean> {
    return this.suppressed.has(normalizeEmail(email))
  }

  async insertMessage(m: NewMessage): Promise<MessageRow> {
    this.seq += 1
    const now = new Date(this.seq)
    const row: MessageRow = {
      id: `log-${this.seq}`,
      sesMessageId: null,
      source: m.source,
      status: m.status,
      fromAddress: m.fromAddress,
      toAddress: normalizeEmail(m.toAddress),
      replyTo: m.replyTo ?? null,
      subject: m.subject,
      html: m.html,
      text: m.text,
      contentStored: m.contentStored,
      headers: m.headers ?? null,
      apiKeyId: m.apiKeyId ?? null,
      apiKeyName: m.apiKeyName ?? null,
      templateId: m.templateId ?? null,
      contactId: m.contactId ?? null,
      flowId: m.flowId ?? null,
      scheduledAt: m.scheduledAt ?? null,
      error: m.error ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.messages.push(row)
    return row
  }

  async updateMessage(id: string, patch: Partial<MessageRow>): Promise<MessageRow> {
    const i = this.messages.findIndex((m) => m.id === id)
    if (i < 0) throw new Error(`no message ${id}`)
    this.messages[i] = { ...this.messages[i]!, ...patch }
    return this.messages[i]!
  }

  async getMessage(id: string): Promise<MessageRow | null> {
    return this.messages.find((m) => m.id === id) ?? null
  }

  async addEvent(messageId: string, status: MessageStatus, detail: Record<string, unknown> | null): Promise<void> {
    this.events.push({ messageId, status, detail })
  }

  async enqueueJob(kind: string, payload: Record<string, unknown>, runAt: Date, dedupeKey?: string): Promise<void> {
    this.jobs.push({ kind, payload, runAt, ...(dedupeKey ? { dedupeKey } : {}) })
  }
}
