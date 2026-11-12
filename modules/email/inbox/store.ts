import type { Folder, MailboxKind, Verdict } from './types'

/**
 * Persistence seam for mailboxes and received mail (migration 0129): the DB
 * store in production, the in-memory one in unit tests. Who may read what is
 * decided in ./service.ts, never here.
 */

/** A mailbox with its primary address. `ownerUserId` for personal, `groupId` for shared. */
export type MailboxRow = {
  id: string
  kind: MailboxKind
  ownerUserId: string | null
  groupId: string | null
  displayName: string | null
  /** Set = receives no new mail; what it holds stays readable for whoever could read it. */
  disabledAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

/** Every address mail is received on, unique across the company: one primary per mailbox, the rest aliases. */
export type AddressRow = {
  address: string
  mailboxId: string
  domainId: string
  primary: boolean
  createdBy: string
  createdAt: Date
}

export type MailPerson = { name: string | null; address: string }

export type MessageVerdicts = { spam: Verdict; virus: Verdict; spf: Verdict; dkim: Verdict; dmarc: Verdict }

/** One received (or sent) mail as it sits in one mailbox. The same mail to two mailboxes is two rows. */
export type MessageRow = {
  id: string
  mailboxId: string
  folder: Folder
  threadId: string
  /** The RFC 5322 Message-ID header, without angle brackets. */
  messageId: string | null
  /** SES receipt id (= the S3 object key); null for mail sent from the webmail. */
  sesMessageId: string | null
  inReplyTo: string | null
  references: string[]
  from: MailPerson
  to: MailPerson[]
  cc: MailPerson[]
  subject: string
  snippet: string
  textBody: string | null
  htmlBody: string | null
  receivedAt: Date
  readAt: Date | null
  starred: boolean
  /** Null for mail sent from the webmail. */
  verdicts: MessageVerdicts | null
  rawS3Key: string | null
  sizeBytes: number
  createdAt: Date
}

export type MessageSummary = Omit<MessageRow, 'textBody' | 'htmlBody'>

export type MailboxStats = { messages: number; unread: number; sizeBytes: number }

export type MailboxPatch = Partial<Pick<MailboxRow, 'displayName' | 'disabledAt'>> & { updatedAt: Date }

export type InboxStore = {
  /** Inserts the mailbox and its primary address together; fails if the address exists. */
  insertMailbox(mailbox: MailboxRow, primary: AddressRow): Promise<void>
  getMailbox(id: string): Promise<MailboxRow | null>
  listMailboxes(): Promise<MailboxRow[]>
  updateMailbox(id: string, patch: MailboxPatch): Promise<void>
  /** The member's personal mailbox, if one is assigned. */
  personalMailboxOf(userId: string): Promise<MailboxRow | null>

  getAddress(address: string): Promise<AddressRow | null>
  /** All addresses, primary first per mailbox, then by address. */
  listAddresses(): Promise<AddressRow[]>
  insertAddress(row: AddressRow): Promise<void>
  /** Removes an alias; a primary address is never deleted on its own. */
  deleteAlias(address: string): Promise<void>

  insertMessage(row: MessageRow): Promise<void>
  getMessage(id: string): Promise<MessageRow | null>
  /** Newest first. */
  listMessages(mailboxId: string, folder: Folder, limit: number): Promise<MessageSummary[]>
  /** Counts and sizes per mailbox id (mailboxes with no mail are absent). */
  stats(): Promise<Map<string, MailboxStats>>
}
