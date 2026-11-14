import type { AddressRow, AttachmentRow, FolderCount, InboxStore, LabelRow, ListedMessage, ListQuery, MailboxRow, MessageRow, MessageSummary } from './store'
import type { MemberRole } from '$lib/server/auth/user-role'
import { InboxError } from './errors'
import {
  FOLDERS,
  LABEL_COLORS,
  LIST_FILTERS,
  LIST_SORTS,
  MAX_LABEL_CHARS,
  MOVE_TARGETS,
  normalizeLocalPart,
  suggestLocalPart,
  type Folder,
  type ListFilter,
  type ListSort,
  type MailboxKind,
  type MoveTarget,
} from './types'

/**
 * Mailboxes and who reads them (plan/email-inbox.md, owner decisions
 * 2026-11-12):
 * - the owner and admins assign addresses by hand and see counts and sizes —
 *   never subjects, senders or bodies;
 * - a personal mailbox is read only by its member (not the owner, not admins);
 * - a shared mailbox is read by the members of its group;
 * - someone no longer in the company reads nothing;
 * - no agent path: nothing here takes an agent principal.
 * Anything a person may not read answers `not_found`, as if it didn't exist.
 */

export type InboxMember = { id: string; name: string; email: string; firstName: string | null; lastName: string | null }
export type InboxGroup = { id: string; name: string; memberIds: string[] }
export type InboxDomain = { id: string; name: string }
export type InboxAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type InboxDeps = {
  store: InboxStore
  roleOf: (userId: string) => Promise<MemberRole | null>
  members: () => Promise<InboxMember[]>
  groups: () => Promise<InboxGroup[]>
  /** Verified (sendable) company domains only. */
  domains: () => Promise<InboxDomain[]>
  audit: InboxAudit
  now?: () => Date
  newId?: () => string
}

export type MailboxView = {
  id: string
  address: string
  aliases: string[]
  kind: MailboxKind
  ownerUserId: string | null
  groupId: string | null
  displayName: string | null
  disabled: boolean
}

export type AdminMailboxView = {
  id: string
  address: string
  aliases: string[]
  kind: MailboxKind
  /** The member's name (personal) or the group's name (shared). */
  holder: string
  displayName: string | null
  disabled: boolean
  messages: number
  unread: number
  sizeBytes: number
}

export type MailboxAdminView = {
  mailboxes: AdminMailboxView[]
  members: Array<{ id: string; name: string; suggested: string | null; mailbox: string | null }>
  groups: Array<{ id: string; name: string }>
  domains: InboxDomain[]
}

const now = (deps: InboxDeps) => deps.now?.() ?? new Date()
const newId = (deps: InboxDeps) => deps.newId?.() ?? crypto.randomUUID()
const byText = (a: string, b: string) => a.localeCompare(b)

async function assertAdmin(deps: InboxDeps, userId: string): Promise<void> {
  const role = await deps.roleOf(userId)
  if (role !== 'owner' && role !== 'admin') {
    throw new InboxError('forbidden', 'Only the owner or an admin can manage mailboxes.')
  }
}

function cleanDisplayName(input: string | null | undefined): string | null {
  const v = (input ?? '').trim()
  if (v.length > 120) throw new InboxError('invalid', 'Keep the name recipients see under 120 characters.')
  return v === '' ? null : v
}

/** A new address on a verified domain that nobody holds yet. */
async function freshAddress(deps: InboxDeps, localPart: string, domainId: string): Promise<{ address: string; domainId: string }> {
  const local = normalizeLocalPart(localPart)
  if (!local.ok) throw new InboxError('invalid', local.message)
  const domain = (await deps.domains()).find((d) => d.id === domainId)
  if (!domain) throw new InboxError('invalid', 'Pick a verified domain. Domains are added and verified under Setup › Account.')
  const address = `${local.value}@${domain.name.toLowerCase()}`
  if (await deps.store.getAddress(address)) throw new InboxError('taken', `${address} is already in use. Pick another address.`)
  return { address, domainId: domain.id }
}

function toView(m: MailboxRow, addresses: AddressRow[]): MailboxView {
  const mine = addresses.filter((a) => a.mailboxId === m.id)
  const primary = mine.find((a) => a.primary)
  if (!primary) throw new Error(`mailbox ${m.id} has no primary address`)
  return {
    id: m.id,
    address: primary.address,
    aliases: mine.filter((a) => !a.primary).map((a) => a.address).sort(byText),
    kind: m.kind,
    ownerUserId: m.ownerUserId,
    groupId: m.groupId,
    displayName: m.displayName,
    disabled: m.disabledAt !== null,
  }
}

async function viewOf(deps: InboxDeps, m: MailboxRow): Promise<MailboxView> {
  return toView(m, await deps.store.listAddresses())
}

async function create(
  deps: InboxDeps,
  actorId: string,
  owner: { kind: 'personal'; userId: string } | { kind: 'shared'; groupId: string },
  input: { localPart: string; domainId: string; displayName?: string | null },
): Promise<MailboxView> {
  const displayName = cleanDisplayName(input.displayName)
  const { address, domainId } = await freshAddress(deps, input.localPart, input.domainId)
  const at = now(deps)
  const mailbox: MailboxRow = {
    id: newId(deps),
    kind: owner.kind,
    ownerUserId: owner.kind === 'personal' ? owner.userId : null,
    groupId: owner.kind === 'shared' ? owner.groupId : null,
    displayName,
    disabledAt: null,
    createdBy: actorId,
    createdAt: at,
    updatedAt: at,
  }
  await deps.store.insertMailbox(mailbox, { address, mailboxId: mailbox.id, domainId, primary: true, createdBy: actorId, createdAt: at })
  await deps.audit({
    type: 'email.mailbox_assigned',
    principalId: actorId,
    payload: {
      mailboxId: mailbox.id,
      address,
      kind: owner.kind,
      ...(owner.kind === 'personal' ? { memberId: owner.userId } : { groupId: owner.groupId }),
    },
  })
  return viewOf(deps, mailbox)
}

/** The owner or an admin gives a member their personal mailbox (one per member). */
export async function assignPersonalMailbox(
  deps: InboxDeps,
  actorId: string,
  input: { memberId: string; localPart: string; domainId: string; displayName?: string | null },
): Promise<MailboxView> {
  await assertAdmin(deps, actorId)
  const member = (await deps.members()).find((m) => m.id === input.memberId)
  if (!member) throw new InboxError('not_found', 'No such member.')
  const existing = await deps.store.personalMailboxOf(member.id)
  if (existing) {
    const { address } = await viewOf(deps, existing)
    throw new InboxError('invalid', `${member.name || member.email} already has a mailbox (${address}). Add another address to it as an alias.`)
  }
  return create(deps, actorId, { kind: 'personal', userId: member.id }, input)
}

/** The owner or an admin creates an address (info@, sales@) read by one group. */
export async function createSharedMailbox(
  deps: InboxDeps,
  actorId: string,
  input: { groupId: string; localPart: string; domainId: string; displayName?: string | null },
): Promise<MailboxView> {
  await assertAdmin(deps, actorId)
  const group = (await deps.groups()).find((g) => g.id === input.groupId)
  if (!group) throw new InboxError('not_found', 'No such group.')
  return create(deps, actorId, { kind: 'shared', groupId: group.id }, input)
}

async function mailboxFor(deps: InboxDeps, mailboxId: string): Promise<MailboxRow> {
  const m = await deps.store.getMailbox(mailboxId)
  if (!m) throw new InboxError('not_found', 'No such mailbox.')
  return m
}

/** Another address delivering into the same mailbox. */
export async function addAlias(
  deps: InboxDeps,
  actorId: string,
  input: { mailboxId: string; localPart: string; domainId: string },
): Promise<MailboxView> {
  await assertAdmin(deps, actorId)
  const mailbox = await mailboxFor(deps, input.mailboxId)
  const { address, domainId } = await freshAddress(deps, input.localPart, input.domainId)
  await deps.store.insertAddress({ address, mailboxId: mailbox.id, domainId, primary: false, createdBy: actorId, createdAt: now(deps) })
  await deps.audit({ type: 'email.mailbox_alias_added', principalId: actorId, payload: { mailboxId: mailbox.id, address } })
  return viewOf(deps, mailbox)
}

export async function removeAlias(deps: InboxDeps, actorId: string, input: { address: string }): Promise<void> {
  await assertAdmin(deps, actorId)
  const address = input.address.trim().toLowerCase()
  const row = await deps.store.getAddress(address)
  if (!row) throw new InboxError('not_found', `${address} isn’t an address of any mailbox.`)
  if (row.primary) throw new InboxError('invalid', `${address} is the mailbox’s main address, not an alias.`)
  await deps.store.deleteAlias(address)
  await deps.audit({ type: 'email.mailbox_alias_removed', principalId: actorId, payload: { mailboxId: row.mailboxId, address } })
}

/** A disabled mailbox receives no new mail; what it holds stays readable. */
export async function setMailboxDisabled(
  deps: InboxDeps,
  actorId: string,
  input: { mailboxId: string; disabled: boolean },
): Promise<MailboxView> {
  await assertAdmin(deps, actorId)
  const mailbox = await mailboxFor(deps, input.mailboxId)
  const at = now(deps)
  const disabledAt = input.disabled ? (mailbox.disabledAt ?? at) : null
  await deps.store.updateMailbox(mailbox.id, { disabledAt, updatedAt: at })
  await deps.audit({
    type: input.disabled ? 'email.mailbox_disabled' : 'email.mailbox_enabled',
    principalId: actorId,
    payload: { mailboxId: mailbox.id },
  })
  return viewOf(deps, { ...mailbox, disabledAt })
}

/** Setup › Mailboxes: addresses, holders and counts — no mail content. */
export async function mailboxAdmin(deps: InboxDeps, actorId: string): Promise<MailboxAdminView> {
  await assertAdmin(deps, actorId)
  const [mailboxes, addresses, stats, members, groups, domains] = await Promise.all([
    deps.store.listMailboxes(),
    deps.store.listAddresses(),
    deps.store.stats(),
    deps.members(),
    deps.groups(),
    deps.domains(),
  ])
  const memberName = new Map(members.map((m) => [m.id, m.name || m.email]))
  const groupName = new Map(groups.map((g) => [g.id, g.name]))
  const views = mailboxes.map((m) => toView(m, addresses))
  const personalOf = new Map(views.filter((v) => v.ownerUserId).map((v) => [v.ownerUserId!, v.address]))
  return {
    mailboxes: views
      .map((v): AdminMailboxView => {
        const s = stats.get(v.id) ?? { messages: 0, unread: 0, sizeBytes: 0 }
        const holder = v.kind === 'personal' ? memberName.get(v.ownerUserId!) : groupName.get(v.groupId!)
        return {
          id: v.id,
          address: v.address,
          aliases: v.aliases,
          kind: v.kind,
          holder: holder ?? (v.kind === 'personal' ? 'A former member' : 'A deleted group'),
          displayName: v.displayName,
          disabled: v.disabled,
          ...s,
        }
      })
      .sort((a, b) => byText(a.address, b.address)),
    members: members
      .map((m) => ({ id: m.id, name: m.name || m.email, suggested: suggestLocalPart(m), mailbox: personalOf.get(m.id) ?? null }))
      .sort((a, b) => byText(a.name, b.name)),
    groups: groups.map((g) => ({ id: g.id, name: g.name })).sort((a, b) => byText(a.name, b.name)),
    domains: [...domains].sort((a, b) => byText(a.name, b.name)),
  }
}

async function canRead(deps: InboxDeps, userId: string, m: MailboxRow, groups?: InboxGroup[]): Promise<boolean> {
  if (m.kind === 'personal') return m.ownerUserId === userId
  const all = groups ?? (await deps.groups())
  return all.some((g) => g.id === m.groupId && g.memberIds.includes(userId))
}

/** The mailboxes this person reads: their own first, then shared ones by address. */
export async function readableMailboxes(deps: InboxDeps, userId: string): Promise<MailboxView[]> {
  if (!(await deps.roleOf(userId))) return []
  const [mailboxes, addresses, groups] = await Promise.all([deps.store.listMailboxes(), deps.store.listAddresses(), deps.groups()])
  const mine: MailboxRow[] = []
  for (const m of mailboxes) if (await canRead(deps, userId, m, groups)) mine.push(m)
  return mine
    .map((m) => toView(m, addresses))
    .sort((a, b) => Number(b.kind === 'personal') - Number(a.kind === 'personal') || byText(a.address, b.address))
}

/** The mailbox, if this person may read it; otherwise "not found". */
async function readable(deps: InboxDeps, userId: string, mailboxId: string): Promise<MailboxRow> {
  const notFound = new InboxError('not_found', 'No such mailbox.')
  if (!(await deps.roleOf(userId))) throw notFound
  const m = await deps.store.getMailbox(mailboxId)
  if (!m || !(await canRead(deps, userId, m))) throw notFound
  return m
}

/** The mailbox with its addresses, if this person may read it; otherwise "not found". */
export async function readableMailbox(deps: InboxDeps, userId: string, mailboxId: string): Promise<MailboxView> {
  return viewOf(deps, await readable(deps, userId, mailboxId))
}

export const MESSAGE_PAGE = 100

export async function listMessages(
  deps: InboxDeps,
  userId: string,
  input: { mailboxId: string; folder: Folder },
): Promise<MessageSummary[]> {
  const m = await readable(deps, userId, input.mailboxId)
  return deps.store.listMessages(m.id, { folder: input.folder }, MESSAGE_PAGE)
}

export async function getMessage(deps: InboxDeps, userId: string, messageId: string): Promise<MessageRow> {
  const msg = await deps.store.getMessage(messageId)
  if (!msg) throw new InboxError('not_found', 'No such mail.')
  try {
    await readable(deps, userId, msg.mailboxId)
  } catch {
    throw new InboxError('not_found', 'No such mail.')
  }
  return msg
}

// ─── reading (S4) ─────────────────────────────────────────────────────────────

/** Whether this person reads the mailbox now — the live stream asks this for every event. */
export async function canReadMailbox(deps: InboxDeps, userId: string, mailboxId: string): Promise<boolean> {
  try {
    await readable(deps, userId, mailboxId)
    return true
  } catch (err) {
    if (err instanceof InboxError && err.code === 'not_found') return false
    throw err
  }
}

/** Total and unread for every folder of a mailbox (zero when empty). */
export async function folderCounts(deps: InboxDeps, userId: string, mailboxId: string): Promise<Record<Folder, FolderCount>> {
  const m = await readable(deps, userId, mailboxId)
  const counts = await deps.store.folderCounts(m.id)
  return Object.fromEntries(FOLDERS.map((f) => [f, counts.get(f) ?? { total: 0, unread: 0 }])) as Record<Folder, FolderCount>
}

export const MAX_SEARCH_CHARS = 200

/**
 * One view of a mailbox: a folder, Starred (`view: 'starred'`) or a label (`labelId`) — the last two span
 * every folder but Spam and Trash. `search` is the reader's search box (a literal substring, never a
 * classifier); `filter` narrows to unread mail or mail with attachments; `sort` is by received time.
 */
export async function listFolder(
  deps: InboxDeps,
  userId: string,
  input: {
    mailboxId: string
    folder?: Folder
    view?: 'starred'
    labelId?: string
    search?: string | null
    filter?: ListFilter | null
    sort?: ListSort | null
  },
): Promise<ListedMessage[]> {
  const search = (input.search ?? '').trim()
  if (search.length > MAX_SEARCH_CHARS) throw new InboxError('invalid', `Keep the search under ${MAX_SEARCH_CHARS} characters.`)
  if (input.filter && !(LIST_FILTERS as readonly string[]).includes(input.filter)) throw new InboxError('invalid', 'Unknown filter.')
  if (input.sort && !(LIST_SORTS as readonly string[]).includes(input.sort)) throw new InboxError('invalid', 'Unknown sort order.')
  const m = await readable(deps, userId, input.mailboxId)
  const query: ListQuery = { folder: input.folder ?? null }
  if (input.view === 'starred') query.starred = true
  if (input.labelId !== undefined) {
    const label = await deps.store.getLabel(input.labelId)
    if (!label || label.mailboxId !== m.id) throw new InboxError('not_found', 'No such label.')
    query.labelId = label.id
  }
  if (query.folder === null && !query.starred && query.labelId === undefined) {
    throw new InboxError('invalid', 'Pick a folder, Starred or a label.')
  }
  if (search !== '') query.search = search
  if (input.filter) query.filter = input.filter
  if (input.sort) query.sort = input.sort
  return deps.store.listMessages(m.id, query, MESSAGE_PAGE)
}

// ─── labels ───────────────────────────────────────────────────────────────────

/** A mailbox's labels, by name; whoever reads the mailbox sees and uses them. */
export async function listLabels(deps: InboxDeps, userId: string, mailboxId: string): Promise<LabelRow[]> {
  const m = await readable(deps, userId, mailboxId)
  return deps.store.listLabels(m.id)
}

export async function createLabel(
  deps: InboxDeps,
  userId: string,
  input: { mailboxId: string; name: string; color: string },
): Promise<LabelRow> {
  const m = await readable(deps, userId, input.mailboxId)
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (name === '') throw new InboxError('invalid', 'Give the label a name.')
  if (name.length > MAX_LABEL_CHARS) throw new InboxError('invalid', `Keep a label name to ${MAX_LABEL_CHARS} characters.`)
  if (!(LABEL_COLORS as readonly string[]).includes(input.color)) throw new InboxError('invalid', 'Pick one of the label colours.')
  const clash = (await deps.store.listLabels(m.id)).find((l) => l.name.toLowerCase() === name.toLowerCase())
  if (clash) throw new InboxError('invalid', `There is already a label called “${clash.name}”.`)
  const row: LabelRow = {
    id: newId(deps),
    mailboxId: m.id,
    name,
    color: input.color as LabelRow['color'],
    createdBy: userId,
    createdAt: now(deps),
  }
  await deps.store.insertLabel(row)
  return row
}

/** The label is gone from the mailbox and from every mail; the mail itself stays where it is. */
export async function deleteLabel(deps: InboxDeps, userId: string, input: { labelId: string }): Promise<void> {
  const label = await deps.store.getLabel(input.labelId)
  if (!label) throw new InboxError('not_found', 'No such label.')
  try {
    await readable(deps, userId, label.mailboxId)
  } catch {
    throw new InboxError('not_found', 'No such label.')
  }
  await deps.store.deleteLabel(label.id)
}

/** The labels on one mail this person reads. */
export async function messageLabelIds(deps: InboxDeps, userId: string, messageId: string): Promise<string[]> {
  const msg = await getMessage(deps, userId, messageId)
  return deps.store.messageLabelIds(msg.id)
}

/** Puts a label on a mail or takes it off — only a label of the mail's own mailbox. */
export async function setMessageLabel(
  deps: InboxDeps,
  userId: string,
  input: { messageId: string; labelId: string; on: boolean },
): Promise<void> {
  const msg = await getMessage(deps, userId, input.messageId)
  const label = await deps.store.getLabel(input.labelId)
  if (!label || label.mailboxId !== msg.mailboxId) throw new InboxError('not_found', 'No such label.')
  await deps.store.setMessageLabel(msg.id, label.id, input.on)
}

export type ThreadView = {
  /** The mail that was opened. */
  message: MessageRow
  /** Every mail of its thread in the same mailbox (the opened one included), oldest first. */
  messages: MessageRow[]
  /** Attachments per message id (an entry for every message). */
  attachments: Map<string, AttachmentRow[]>
}

export async function getThread(deps: InboxDeps, userId: string, messageId: string): Promise<ThreadView> {
  const message = await getMessage(deps, userId, messageId)
  const messages = await deps.store.threadMessages(message.mailboxId, message.threadId)
  const attachments = new Map<string, AttachmentRow[]>()
  for (const m of messages) attachments.set(m.id, await deps.store.listAttachments(m.id))
  return { message, messages, attachments }
}

export async function setRead(deps: InboxDeps, userId: string, input: { messageId: string; read: boolean }): Promise<void> {
  const m = await getMessage(deps, userId, input.messageId)
  // Reading again keeps the first time it was read.
  const readAt = input.read ? (m.readAt ?? now(deps)) : null
  await deps.store.updateMessage(m.id, { readAt })
}

export async function setStarred(deps: InboxDeps, userId: string, input: { messageId: string; starred: boolean }): Promise<void> {
  const m = await getMessage(deps, userId, input.messageId)
  await deps.store.updateMessage(m.id, { starred: input.starred })
}

/** Archive, Trash, Spam, and back to the Inbox ("Not spam"). Nothing is deleted for good here. */
export async function moveMessage(deps: InboxDeps, userId: string, input: { messageId: string; folder: MoveTarget }): Promise<void> {
  if (!(MOVE_TARGETS as readonly string[]).includes(input.folder)) {
    throw new InboxError('invalid', 'Mail can be moved to the Inbox, Archive, Trash or Spam.')
  }
  const m = await getMessage(deps, userId, input.messageId)
  await deps.store.updateMessage(m.id, { folder: input.folder })
}

/** An attachment with its mail, if this person reads the mail's mailbox; otherwise "not found". */
export async function attachmentFor(
  deps: InboxDeps,
  userId: string,
  attachmentId: string,
): Promise<{ attachment: AttachmentRow; message: MessageRow }> {
  const attachment = await deps.store.getAttachment(attachmentId)
  if (!attachment) throw new InboxError('not_found', 'No such attachment.')
  try {
    return { attachment, message: await getMessage(deps, userId, attachment.messageId) }
  } catch (err) {
    if (err instanceof InboxError && err.code === 'not_found') throw new InboxError('not_found', 'No such attachment.')
    throw err
  }
}

/** Every address that should receive mail now (enabled mailboxes, aliases included) — the SES rule recipients (S2). */
export async function receivingAddresses(deps: InboxDeps): Promise<string[]> {
  const [mailboxes, addresses] = await Promise.all([deps.store.listMailboxes(), deps.store.listAddresses()])
  const enabled = new Set(mailboxes.filter((m) => m.disabledAt === null).map((m) => m.id))
  return addresses
    .filter((a) => enabled.has(a.mailboxId))
    .map((a) => a.address)
    .sort(byText)
}
