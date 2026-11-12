import type { AddressRow, InboxStore, MailboxRow, MailboxStats, MessageRow } from './store'

/** In-memory InboxStore for unit tests (same semantics as the DB store). */
export function memoryInboxStore(): InboxStore & {
  mailboxes: Map<string, MailboxRow>
  addresses: Map<string, AddressRow>
  messages: Map<string, MessageRow>
} {
  const mailboxes = new Map<string, MailboxRow>()
  const addresses = new Map<string, AddressRow>()
  const messages = new Map<string, MessageRow>()
  const copy = <T>(v: T): T => structuredClone(v)
  return {
    mailboxes,
    addresses,
    messages,
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
    async getMessage(id) {
      const m = messages.get(id)
      return m ? copy(m) : null
    },
    async listMessages(mailboxId, folder, limit) {
      return [...messages.values()]
        .filter((m) => m.mailboxId === mailboxId && m.folder === folder)
        .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(({ textBody: _t, htmlBody: _h, ...summary }) => copy(summary))
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
