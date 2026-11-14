import type { Folder, LabelColor, ListFilter, ListSort, MailboxKind, Verdict } from './types'

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
  /** Only the sender's own copy in Sent has any (S5); received mail never shows its Bcc. */
  bcc: MailPerson[]
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

/** A mail as a list shows it: its labels and whether it has attachments. */
export type ListedMessage = MessageSummary & { labelIds: string[]; hasAttachments: boolean }

/** A mailbox's label (migration 0142). */
export type LabelRow = { id: string; mailboxId: string; name: string; color: LabelColor; createdBy: string; createdAt: Date }

/**
 * Which mail a list shows. `folder` null = every folder but Spam and Trash (Starred, a label).
 * `search` (already trimmed, non-empty) is a literal, case-insensitive substring of the subject,
 * the sender's name or address, or the snippet.
 */
export type ListQuery = {
  folder: Folder | null
  search?: string
  starred?: boolean
  labelId?: string
  filter?: ListFilter
  sort?: ListSort
}

/** The folders a cross-folder view (Starred, a label) leaves out. */
export const HIDDEN_FROM_VIEWS: readonly Folder[] = ['spam', 'trash']

/**
 * One attachment of a received mail (migration 0131). The bytes stay in the raw
 * MIME object (`MessageRow.rawS3Key`): `partIndex` is the position in
 * mailparser's attachment list of that object, `checksum` the md5 of the
 * decoded bytes, so the download (S4) can find and prove the same part again.
 */
export type AttachmentRow = {
  id: string
  messageId: string
  partIndex: number
  filename: string | null
  contentType: string
  sizeBytes: number
  contentId: string | null
  checksum: string
  /** SES virus verdict FAIL: listed, never downloadable. */
  blocked: boolean
  createdAt: Date
}

/** A receiving address and the mailbox it delivers into. */
export type AddressMailbox = { address: string; mailbox: MailboxRow }

/** Postgres NOTIFY channel for newly stored mail; the payload is the mailbox id (S4's live view listens). */
export const INBOX_NOTIFY_CHANNEL = 'inbox_messages'

export type MailboxStats = { messages: number; unread: number; sizeBytes: number }

export type MailboxPatch = Partial<Pick<MailboxRow, 'displayName' | 'disabledAt'>> & { updatedAt: Date }

/** What a reader changes on one mail (S4): read state, star, folder. */
export type MessagePatch = Partial<Pick<MessageRow, 'readAt' | 'starred' | 'folder'>>

export type FolderCount = { total: number; unread: number }

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
  /**
   * Stores a received mail with its attachments in one transaction and notifies
   * INBOX_NOTIFY_CHANNEL. Idempotent per (mailbox, SES message id): when that
   * pair is already stored nothing is written and `stored` is false (SNS retry).
   */
  insertReceived(row: MessageRow & { sesMessageId: string }, attachments: AttachmentRow[]): Promise<{ stored: boolean }>
  /** Attachments of one message, by part index. */
  listAttachments(messageId: string): Promise<AttachmentRow[]>
  /**
   * The thread of the earliest stored mail in this mailbox whose RFC Message-ID
   * is one of `messageIds` (no angle brackets); null when none is.
   */
  threadOf(mailboxId: string, messageIds: string[]): Promise<string | null>
  /** The mailboxes these exact addresses deliver into (disabled ones included); unknown addresses are absent. */
  mailboxesFor(addresses: string[]): Promise<AddressMailbox[]>
  getMessage(id: string): Promise<MessageRow | null>
  /** One view of a mailbox, newest first unless `sort` says oldest. */
  listMessages(mailboxId: string, query: ListQuery, limit: number): Promise<ListedMessage[]>
  /** Total and unread per folder of one mailbox (folders with no mail are absent). */
  folderCounts(mailboxId: string): Promise<Map<Folder, FolderCount>>
  /** Every mail of one thread in one mailbox, oldest first. */
  threadMessages(mailboxId: string, threadId: string): Promise<MessageRow[]>
  /** Changes one mail and notifies INBOX_NOTIFY_CHANNEL with its mailbox id (other open tabs follow). */
  updateMessage(id: string, patch: MessagePatch): Promise<void>
  getAttachment(id: string): Promise<AttachmentRow | null>
  /** A mailbox's labels by name (case-insensitive). */
  listLabels(mailboxId: string): Promise<LabelRow[]>
  getLabel(id: string): Promise<LabelRow | null>
  /** Fails if the mailbox already has a label of that name (any case). */
  insertLabel(row: LabelRow): Promise<void>
  /** Deletes the label and takes it off every mail; notifies INBOX_NOTIFY_CHANNEL. */
  deleteLabel(id: string): Promise<void>
  /** The label ids on one mail, sorted. */
  messageLabelIds(messageId: string): Promise<string[]>
  /** Puts a label on a mail (idempotent) or takes it off; notifies INBOX_NOTIFY_CHANNEL. */
  setMessageLabel(messageId: string, labelId: string, on: boolean): Promise<void>
  /** Counts and sizes per mailbox id (mailboxes with no mail are absent). */
  stats(): Promise<Map<string, MailboxStats>>
}
