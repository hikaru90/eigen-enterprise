import type { ContactMail, ContactMailPort } from './service'
import { and, desc, inArray, notInArray, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { mailMessages } from '$lib/server/db/email.schema'
import { inboxMessages } from '$lib/server/db/inbox.schema'
import { HISTORY_MAIL_LIMIT } from './types'

/**
 * Mail in a contact's history (Contribute b8a87a25). Contacts never decides
 * who reads a mailbox: Email does. The live port (wired outside the module,
 * in the people routes' `contact-mail.server.ts`, since modules don't import
 * each other) asks Email's own functions —
 * `readableMailboxes` (personal: only its member; shared: its group; the
 * owner included in "nobody else") and the Company-mail rule (the owner and
 * admins: what the company sends; never a member's webmail, which writes no
 * `mail_messages` row) — and only then reads mail, restricted to exactly those
 * mailbox ids. Spam and Trash are left out. Subjects and snippets only; the
 * link opens the mail where Email shows it (and checks access again).
 */

/** Folders whose mail is not part of anyone's history. */
const NOT_HISTORY = ['spam', 'trash'] as const

/** `(a, b, …)` of the addresses, each a bound parameter. */
const list = (addresses: string[]) => sql`(${sql.join(
  addresses.map((a) => sql`${a}`),
  sql`, `,
)})`

const addressIn = (field: 'from' | 'to' | 'cc' | 'bcc', addresses: string[]) =>
  field === 'from'
    ? sql`lower(${inboxMessages.from} ->> 'address') in ${list(addresses)}`
    : sql`exists (select 1 from jsonb_array_elements(${inboxMessages[field]}) p where lower(p ->> 'address') in ${list(addresses)})`

/** Mail from or to these addresses (lower case) in these mailboxes, newest first. */
export async function mailboxMailWith(
  db: AppDatabase,
  boxes: Array<{ id: string; address: string }>,
  addresses: string[],
  /** Where the mail opens (Email's Inbox reader link). */
  hrefOf: (m: { mailboxId: string; folder: (typeof inboxMessages.$inferSelect)['folder']; id: string }) => string,
  limit: number = HISTORY_MAIL_LIMIT,
): Promise<ContactMail[]> {
  if (boxes.length === 0 || addresses.length === 0) return []
  const addressOf = new Map(boxes.map((b) => [b.id, b.address]))
  const rows = await db
    .select({
      id: inboxMessages.id,
      mailboxId: inboxMessages.mailboxId,
      folder: inboxMessages.folder,
      subject: inboxMessages.subject,
      snippet: inboxMessages.snippet,
      receivedAt: inboxMessages.receivedAt,
    })
    .from(inboxMessages)
    .where(
      and(
        inArray(inboxMessages.mailboxId, [...addressOf.keys()]),
        notInArray(inboxMessages.folder, [...NOT_HISTORY]),
        sql`(${addressIn('from', addresses)} or ${addressIn('to', addresses)} or ${addressIn('cc', addresses)} or ${addressIn('bcc', addresses)})`,
      ),
    )
    .orderBy(desc(inboxMessages.receivedAt), desc(inboxMessages.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    // Your own copy in Sent is mail you sent them; everything else came in.
    direction: r.folder === 'sent' ? 'sent' : 'received',
    via: { kind: 'mailbox', address: addressOf.get(r.mailboxId)! },
    subject: r.subject,
    snippet: r.snippet === '' ? null : r.snippet,
    at: r.receivedAt,
    href: hrefOf(r),
  }))
}

/** What the company sent to these addresses (lower case), newest first — for the Company-mail rule's readers only. */
export async function companyMailTo(db: AppDatabase, addresses: string[], limit: number = HISTORY_MAIL_LIMIT): Promise<ContactMail[]> {
  if (addresses.length === 0) return []
  const rows = await db
    .select({ id: mailMessages.id, subject: mailMessages.subject, status: mailMessages.status, createdAt: mailMessages.createdAt })
    .from(mailMessages)
    .where(sql`lower(${mailMessages.toAddress}) in ${list(addresses)}`)
    .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(limit)
  return rows.map((r) => ({
    id: r.id,
    direction: 'sent',
    via: { kind: 'company', status: r.status },
    subject: r.subject,
    snippet: null,
    at: r.createdAt,
    href: `/m/email/logs/${r.id}`,
  }))
}

/** What the port is built from: Email's two access answers and the two queries. */
export type ContactMailSources = {
  /** The mailboxes this person reads (Email's `readableMailboxes`). */
  readableMailboxes: (userId: string) => Promise<Array<{ id: string; address: string }>>
  /** The Company-mail rule: the owner and admins (Email's `requireAdmin` asks the same). */
  readsCompanyMail: (userId: string) => Promise<boolean>
  mailbox: (boxes: Array<{ id: string; address: string }>, addresses: string[]) => Promise<ContactMail[]>
  company: (addresses: string[]) => Promise<ContactMail[]>
}

/** Email's access answers first, then only the mail they allow. */
export function contactMailPort(src: ContactMailSources): ContactMailPort {
  return async (userId, addresses) => {
    const [boxes, company] = await Promise.all([src.readableMailboxes(userId), src.readsCompanyMail(userId)])
    const [mine, sent] = await Promise.all([
      boxes.length > 0 ? src.mailbox(boxes, addresses) : Promise.resolve([]),
      company ? src.company(addresses) : Promise.resolve([]),
    ])
    return [...mine, ...sent]
  }
}
