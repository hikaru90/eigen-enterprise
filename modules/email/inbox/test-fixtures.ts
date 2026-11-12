import type { InboxDeps } from './service'
import type { MessageRow } from './store'
import type { MemberRole } from '$lib/server/auth/user-role'
import { memoryInboxStore } from './memory-store'

/**
 * Olga owns the company, Adam is an admin, Ana and Ben are members, Sam is in
 * Sales with Ana. One verified domain (example.com) and one still pending
 * (pending.example, not offered). Fixed clock, sequential ids.
 */
export function fixture() {
  const store = memoryInboxStore()
  const events: Array<{ type: string; principalId: string; payload: Record<string, unknown> }> = []
  const roles: Record<string, MemberRole> = { olga: 'owner', adam: 'admin', ana: 'member', ben: 'member', sam: 'member' }
  let clock = Date.parse('2026-11-12T09:00:00Z')
  let ids = 0
  const deps: InboxDeps = {
    store,
    roleOf: async (userId) => roles[userId] ?? null,
    members: async () => [
      { id: 'olga', name: 'Olga Owner', email: 'olga@home.example', firstName: 'Olga', lastName: 'Owner' },
      { id: 'adam', name: 'Adam Admin', email: 'adam@home.example', firstName: 'Adam', lastName: 'Admin' },
      { id: 'ana', name: 'Ana Lind', email: 'ana@home.example', firstName: 'Ana', lastName: 'Lind' },
      { id: 'ben', name: 'Ben Ode', email: 'ben@home.example', firstName: null, lastName: null },
      { id: 'sam', name: 'Sam Süß', email: 'sam@home.example', firstName: 'Sam', lastName: 'Süß' },
    ],
    groups: async () => [
      { id: 'g-sales', name: 'Sales', memberIds: ['ana', 'sam'] },
      { id: 'g-dev', name: 'Dev', memberIds: ['ben'] },
    ],
    domains: async () => [{ id: 'd-1', name: 'example.com' }],
    audit: async (e) => {
      events.push(e)
    },
    now: () => new Date((clock += 1000)),
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
  }
  return { deps, store, events }
}

/** A received mail in a mailbox, for read-side tests (S3 writes these for real). */
export function message(mailboxId: string, over: Partial<MessageRow> = {}): MessageRow {
  const at = new Date('2026-11-12T08:00:00Z')
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    mailboxId,
    folder: 'inbox',
    threadId: 't-1',
    messageId: 'abc@sender.example',
    sesMessageId: 'ses-1',
    inReplyTo: null,
    references: [],
    from: { name: 'Mara Voss', address: 'mara@sender.example' },
    to: [{ name: null, address: 'ana.lind@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Hello',
    snippet: 'Hi Ana, …',
    textBody: 'Hi Ana, how are you?',
    htmlBody: null,
    receivedAt: at,
    readAt: null,
    starred: false,
    verdicts: { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'PASS', dmarc: 'PASS' },
    rawS3Key: 'ses-1',
    sizeBytes: 2048,
    createdAt: at,
    ...over,
  }
}
