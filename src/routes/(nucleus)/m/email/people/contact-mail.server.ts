import type { ContactMail } from '../../../../../../modules/contacts/service'
import { companyMailTo, contactMailPort, mailboxMailWith } from '../../../../../../modules/contacts/mail-history'
import { inboxHref } from '../../../../../../modules/email/inbox/url'

/**
 * Mail in a contact's history, wired here because modules don't import each
 * other: Email's own access functions decide what this person reads —
 * `readableMailboxes` (personal: its member only; shared: its group) and the
 * Company-mail rule (`isUserAdmin`, the same check as `requireAdmin`) — and
 * only then the contacts module's queries read mail, restricted to exactly
 * those mailboxes. Links open the mail in the Inbox reader or Email › Logs,
 * which check access again.
 */
export async function liveContactMail(userId: string, addresses: string[]): Promise<ContactMail[]> {
  const [{ inboxDeps }, { readableMailboxes }, { isUserAdmin }, { appSql, createScopedDrizzle }] = await Promise.all([
    import('../../../../../../modules/email/inbox/live'),
    import('../../../../../../modules/email/inbox/service'),
    import('$lib/server/auth/user-role'),
    import('$lib/server/db'),
  ])
  const db = createScopedDrizzle(appSql)
  return contactMailPort({
    readableMailboxes: async (id) => readableMailboxes(await inboxDeps(), id),
    readsCompanyMail: isUserAdmin,
    mailbox: (boxes, list) =>
      mailboxMailWith(db, boxes, list, (m) => inboxHref('/m/email/inbox', { box: m.mailboxId, folder: m.folder, m: m.id })),
    company: (list) => companyMailTo(db, list),
  })(userId, addresses)
}
