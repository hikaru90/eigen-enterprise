import type { InboxStore } from './store'

/**
 * The SES receipt-rule recipients (plan/email-inbox.md S2): every address —
 * primary and alias — of an enabled mailbox whose domain has receiving turned
 * on. Mail to any other address never reaches ee (SES blocks it).
 */
export async function receivingRecipients(
  store: Pick<InboxStore, 'listMailboxes' | 'listAddresses'>,
  receivingDomainIds: Iterable<string>,
): Promise<string[]> {
  const domains = new Set(receivingDomainIds)
  if (domains.size === 0) return []
  const [mailboxes, addresses] = await Promise.all([store.listMailboxes(), store.listAddresses()])
  const enabled = new Set(mailboxes.filter((m) => m.disabledAt === null).map((m) => m.id))
  return addresses
    .filter((a) => enabled.has(a.mailboxId) && domains.has(a.domainId))
    .map((a) => a.address)
    .sort((a, b) => a.localeCompare(b))
}
