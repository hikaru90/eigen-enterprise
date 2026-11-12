import type { AddressRow, AttachmentRow, FolderCount, InboxStore, MailboxRow, MailboxStats, MessageRow } from './store'
import type { Folder } from './types'

/**
 * In-memory InboxStore for unit tests (same semantics as the DB store).
 * `notified` stands in for pg_notify on INBOX_NOTIFY_CHANNEL (mailbox ids, in order).
 */
export function memoryInboxStore(): InboxStore & {
  mailboxes: Map<string, MailboxRow>
  addresses: Map<string, AddressRow>
  messages: Map<string, MessageRow>
  attachments: Map<string, AttachmentRow>
  notified: string[]
} {
  const mailboxes = new Map<string, MailboxRow>()
  const addresses = new Map<string, AddressRow>()
  const messages = new Map<string, MessageRow>()
  const attachments = new Map<string, AttachmentRow>()
  const notified: string[] = []
  const copy = <T>(v: T): T => structuredClone(v)
  return {
    mailboxes,
    addresses,
    messages,
    attachments,
    notified,
    async insertMailbox(m, primary) {
      if (mailboxes.has(m.id)) throw new Error(`mailbox ${m.id} exists`)
      if (addresses.has(primary.address)) throw new Error(`address ${primary.address} exists`)
      if (m.kind === 'personal' && [...mailboxes.values()].some((x) => x.kind === 'personal' && x.ownerUserId === m.ownerUserId)) {
        throw new Error(`member ${m.ownerUserId} already has a personal mailbox`)
      }
      mailboxes.set(m.id, copy(m))
      addresses.set(primary.address, copy(primary))
    },
    async getMailbox(id) {
      const m = mailboxes.get(id)
      return m ? copy(m) : null
    },
    async listMailboxes() {
      return [...mailboxes.values()].map(copy)
    },
    async updateMailbox(id, patch) {
      const m = mailboxes.get(id)
      if (!m) throw new Error(`mailbox ${id} not found`)
      mailboxes.set(id, { ...m, ...patch })
    },
    async personalMailboxOf(userId) {
      const m = [...mailboxes.values()].find((x) => x.kind === 'personal' && x.ownerUserId === userId)
      return m ? copy(m) : null
    },
    async getAddress(address) {
      const a = addresses.get(address)
      return a ? copy(a) : null
    },
    async listAddresses() {
      return [...addresses.values()]
        .sort((a, b) => a.mailboxId.localeCompare(b.mailboxId) || Number(b.primary) - Number(a.primary) || a.address.localeCompare(b.address))
        .map(copy)
    },
    async insertAddress(row) {
      if (addresses.has(row.address)) throw new Error(`address ${row.address} exists`)
      if (!mailboxes.has(row.mailboxId)) throw new Error(`mailbox ${row.mailboxId} not found`)
      addresses.set(row.address, copy(row))
    },
    async deleteAlias(address) {
      const a = addresses.get(address)
      if (a?.primary) throw new Error(`${address} is a primary address`)
      addresses.delete(address)
    },
    async insertMessage(row) {
      if (messages.has(row.id)) throw new Error(`message ${row.id} exists`)
      messages.set(row.id, copy(row))
    },
    async insertReceived(row, rows) {
      if ([...messages.values()].some((m) => m.mailboxId === row.mailboxId && m.sesMessageId === row.sesMessageId)) return { stored: false }
      if (!mailboxes.has(row.mailboxId)) throw new Error(`mailbox ${row.mailboxId} not found`)
      if (messages.has(row.id)) throw new Error(`message ${row.id} exists`)
      for (const a of rows) {
        if (a.messageId !== row.id) throw new Error(`attachment ${a.id} belongs to another message`)
        if (attachments.has(a.id)) throw new Error(`attachment ${a.id} exists`)
      }
      if (new Set(rows.map((a) => a.partIndex)).size !== rows.length) throw new Error(`duplicate attachment part in ${row.id}`)
      messages.set(row.id, copy(row))
      for (const a of rows) attachments.set(a.id, copy(a))
      notified.push(row.mailboxId)
      return { stored: true }
    },
    async listAttachments(messageId) {
      return [...attachments.values()]
        .filter((a) => a.messageId === messageId)
        .sort((a, b) => a.partIndex - b.partIndex)
        .map(copy)
    },
    async threadOf(mailboxId, ids) {
      const wanted = new Set(ids)
      const hit = [...messages.values()]
        .filter((m) => m.mailboxId === mailboxId && m.messageId !== null && wanted.has(m.messageId))
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id))[0]
      return hit?.threadId ?? null
    },
    async mailboxesFor(list) {
      const out = []
      for (const address of list) {
        const a = addresses.get(address)
        const m = a ? mailboxes.get(a.mailboxId) : undefined
        if (a && m) out.push({ address, mailbox: copy(m) })
      }
      return out
    },
    async getMessage(id) {
      const m = messages.get(id)
      return m ? copy(m) : null
    },
    async listMessages(mailboxId, folder, limit, search) {
      const needle = search?.toLowerCase()
      const hit = (m: MessageRow) =>
        needle === undefined ||
        [m.subject, m.from.name ?? '', m.from.address, m.snippet].some((v) => v.toLowerCase().includes(needle))
      return [...messages.values()]
        .filter((m) => m.mailboxId === mailboxId && m.folder === folder && hit(m))
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(({ textBody: _t, htmlBody: _h, ...summary }) => copy(summary))
    },
    async folderCounts(mailboxId) {
      const out = new Map<Folder, FolderCount>()
      for (const m of messages.values()) {
        if (m.mailboxId !== mailboxId) continue
        const c = out.get(m.folder) ?? { total: 0, unread: 0 }
        out.set(m.folder, { total: c.total + 1, unread: c.unread + (m.readAt ? 0 : 1) })
      }
      return out
    },
    async threadMessages(mailboxId, threadId) {
      return [...messages.values()]
        .filter((m) => m.mailboxId === mailboxId && m.threadId === threadId)
        .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime() || a.id.localeCompare(b.id))
        .map(copy)
    },
    async updateMessage(id, patch) {
      const m = messages.get(id)
      if (!m) throw new Error(`message ${id} not found`)
      messages.set(id, { ...m, ...copy(patch) })
      notified.push(m.mailboxId)
    },
    async getAttachment(id) {
      const a = attachments.get(id)
      return a ? copy(a) : null
    },
    async stats() {
      const out = new Map<string, MailboxStats>()
      for (const m of messages.values()) {
        const s = out.get(m.mailboxId) ?? { messages: 0, unread: 0, sizeBytes: 0 }
        out.set(m.mailboxId, { messages: s.messages + 1, unread: s.unread + (m.readAt ? 0 : 1), sizeBytes: s.sizeBytes + m.sizeBytes })
      }
      return out
    },
  }
}
