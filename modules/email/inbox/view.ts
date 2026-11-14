import type { ThreadView } from './service'
import type { AttachmentRow, FolderCount, LabelRow, ListedMessage, MailPerson, MessageRow } from './store'
import type { Folder, LabelColor } from './types'
import { attachmentUrl, mailDocument, sanitizeMailHtml } from './html'
import { FOLDERS } from './types'

/**
 * What the Inbox page gets (S4): plain, serialisable views of the reader's own
 * mail. HTML bodies arrive sanitized and wrapped as the iframe's srcdoc.
 */

export const FOLDER_LABELS: Record<Folder, string> = {
  inbox: 'Inbox',
  sent: 'Sent',
  spam: 'Spam',
  trash: 'Trash',
  archive: 'Archive',
}

export type FolderView = { folder: Folder; label: string; total: number; unread: number }

export type MessageListItem = {
  id: string
  from: MailPerson
  subject: string
  snippet: string
  receivedAt: string
  unread: boolean
  starred: boolean
  hasAttachments: boolean
  labelIds: string[]
}

export type LabelView = { id: string; name: string; color: LabelColor }

export function labelView(l: LabelRow): LabelView {
  return { id: l.id, name: l.name, color: l.color }
}

export type AttachmentView = {
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  blocked: boolean
  /** False for mail sent from here: only the metadata is kept, nothing to download (S5). */
  kept: boolean
  /** Same-origin download path. */
  href: string
}

export type MailBody =
  | { kind: 'html'; srcdoc: string; remoteImages: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }

export type ReaderMessage = {
  id: string
  folder: Folder
  from: MailPerson
  to: MailPerson[]
  cc: MailPerson[]
  /** Only on the sender's own copy (S5). */
  bcc: MailPerson[]
  subject: string
  receivedAt: string
  unread: boolean
  starred: boolean
  body: MailBody
  attachments: AttachmentView[]
}

export type ReaderView = {
  /** The opened mail (actions apply to it). */
  id: string
  folder: Folder
  subject: string
  unread: boolean
  starred: boolean
  /** The thread, oldest first, the opened mail included. */
  messages: ReaderMessage[]
  /** Some mail in the thread has remote images that are blocked now. */
  remoteImagesBlocked: boolean
  imagesShown: boolean
}

export function folderViews(counts: Record<Folder, FolderCount>): FolderView[] {
  return FOLDERS.map((folder) => ({ folder, label: FOLDER_LABELS[folder], ...counts[folder] }))
}

export function listItem(m: ListedMessage): MessageListItem {
  return {
    id: m.id,
    from: m.from,
    subject: m.subject,
    snippet: m.snippet,
    receivedAt: m.receivedAt.toISOString(),
    unread: m.readAt === null,
    starred: m.starred,
    hasAttachments: m.hasAttachments,
    labelIds: m.labelIds,
  }
}

function bodyOf(m: MessageRow, attachments: AttachmentRow[], opts: { origin: string; images: boolean }): MailBody {
  if (m.htmlBody !== null) {
    const inline = new Map(attachments.filter((a) => a.contentId !== null && !a.blocked).map((a) => [a.contentId!, a.id]))
    const { html, remoteImages } = sanitizeMailHtml(m.htmlBody, { ...opts, inline })
    return { kind: 'html', srcdoc: mailDocument(html, opts), remoteImages }
  }
  if (m.textBody !== null && m.textBody.trim() !== '') return { kind: 'text', text: m.textBody }
  return { kind: 'empty' }
}

export function readerView(thread: ThreadView, opts: { origin: string; images: boolean }): ReaderView {
  const messages = thread.messages.map((m): ReaderMessage => {
    const attachments = thread.attachments.get(m.id) ?? []
    return {
      id: m.id,
      folder: m.folder,
      from: m.from,
      to: m.to,
      cc: m.cc,
      bcc: m.bcc,
      subject: m.subject,
      receivedAt: m.receivedAt.toISOString(),
      unread: m.readAt === null,
      starred: m.starred,
      body: bodyOf(m, attachments, opts),
      attachments: attachments.map((a) => ({
        id: a.id,
        filename: a.filename ?? 'attachment',
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        blocked: a.blocked,
        kept: m.rawS3Key !== null,
        href: attachmentUrl('', a.id, false),
      })),
    }
  })
  const open = thread.message
  return {
    id: open.id,
    folder: open.folder,
    subject: open.subject,
    unread: open.readAt === null,
    starred: open.starred,
    messages,
    remoteImagesBlocked: !opts.images && messages.some((m) => m.body.kind === 'html' && m.body.remoteImages),
    imagesShown: opts.images,
  }
}
