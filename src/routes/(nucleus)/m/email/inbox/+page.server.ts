import type { ComposeDraft, Upload } from '../../../../../../modules/email/inbox/send'
import type { MoveTarget } from '../../../../../../modules/email/inbox/types'
import type { Actions, PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { CalendarError } from '../../../../../../modules/calendar/errors'
import { calendarAction } from '../../../../../../modules/calendar/http'
import { acceptProposal, dismissProposal, proposalForMail } from '../../../../../../modules/calendar/proposals'
import { InboxError } from '../../../../../../modules/email/inbox/errors'
import { inboxDeps, sendDeps } from '../../../../../../modules/email/inbox/live'
import { composeDraft, sendMail } from '../../../../../../modules/email/inbox/send'
import {
  assignPersonalMailbox,
  createLabel,
  deleteLabel,
  folderCounts,
  getThread,
  listFolder,
  listLabels,
  mailboxAdmin,
  messageLabelIds,
  moveMessage,
  readableMailboxes,
  setMessageLabel,
  setRead,
  setStarred,
} from '../../../../../../modules/email/inbox/service'
import { COMPOSE_MODES, type ComposeMode } from '../../../../../../modules/email/inbox/types'
import { isUuid, parseInboxQuery } from '../../../../../../modules/email/inbox/url'
import { folderViews, labelView, listItem, readerView } from '../../../../../../modules/email/inbox/view'
import { syncMailReceiving } from '../../../../../../modules/email/platform/receiving-sync'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireMember } from '../access.server'
import { INBOX_DEPENDENCY } from './dependency'

/**
 * Email › Inbox (plan/email-inbox.md §4, S4): the mailboxes you read, one
 * folder's mail, and the open thread. Everything goes through the inbox
 * service's access rule; a mailbox or mail you may not read is "not found".
 * Opening a mail does not mark it read here — the page posts ?/read.
 * S5: `?compose=…` opens the compose form (prefilled for a reply or forward of
 * the opened mail); ?/send sends it from a mailbox you read.
 * Calendar K7: an appointment found in an opened mail of your own personal
 * mailbox shows on it (Accept / Edit in Calendar / Dismiss) — only while the
 * Calendar plugin is on, and only to you.
 */

async function proposalSide() {
  return import('$lib/server/calendar/mail-proposals')
}
export const load: PageServerLoad = async ({ locals, url, depends }) => {
  depends(INBOX_DEPENDENCY)
  const me = await requireMember(locals)
  const query = parseInboxQuery(url.searchParams)
  if (!query.ok) error(404, 'Not found')
  const { state } = query
  const deps = await inboxDeps()
  const boxes = await readableMailboxes(deps, me.userId)
  if (boxes.length === 0) {
    // Nothing is readable: a named mailbox or mail is not found, like for anyone else.
    if (state.box || state.m) error(404, state.m ? 'No such mail.' : 'No such mailbox.')
    return { inbox: null, start: await startState(me) }
  }

  let thread: Awaited<ReturnType<typeof getThread>> | null = null
  if (state.m) {
    try {
      thread = await getThread(deps, me.userId, state.m)
    } catch (err) {
      if (err instanceof InboxError && err.code === 'not_found') error(404, 'No such mail.')
      throw err
    }
  }
  const boxId = state.box ?? thread?.message.mailboxId ?? boxes[0]!.id
  const box = boxes.find((b) => b.id === boxId)
  if (!box) error(404, 'No such mailbox.')
  if (thread && thread.message.mailboxId !== box.id) error(404, 'No such mail.')
  // Starred and a label are views across folders; otherwise one folder (the opened mail's, else the Inbox).
  const crossView = state.view !== null || state.label !== null
  const folder = crossView ? null : (state.folder ?? thread?.message.folder ?? 'inbox')
  const labels = await listLabels(deps, me.userId, box.id)
  const label = state.label ? labels.find((l) => l.id === state.label) : null
  if (state.label && !label) error(404, 'No such label.')

  let searchError: string | null = null
  let messages: Awaited<ReturnType<typeof listFolder>> = []
  try {
    messages = await listFolder(deps, me.userId, {
      mailboxId: box.id,
      ...(folder ? { folder } : {}),
      ...(state.view ? { view: state.view } : {}),
      ...(label ? { labelId: label.id } : {}),
      search: state.q,
      filter: state.filter,
      sort: state.sort,
    })
  } catch (err) {
    if (!(err instanceof InboxError && err.code === 'invalid')) throw err
    searchError = err.message
  }

  let compose: ComposeDraft | null = null
  if (state.compose) {
    try {
      compose = await composeDraft(deps, me.userId, { mailboxId: box.id, mode: state.compose, parentId: thread?.message.id ?? null })
    } catch (err) {
      if (err instanceof InboxError && err.code === 'not_found') error(404, 'No such mail.')
      throw err
    }
  }

  let proposal: Awaited<ReturnType<typeof proposalForMail>> = null
  if (thread && box.kind === 'personal') {
    const side = await proposalSide()
    if (await side.calendarOn()) proposal = await proposalForMail(await side.proposalDeps(), { kind: 'user', userId: me.userId }, thread.message.id)
  }

  return {
    start: null,
    inbox: {
      boxes: boxes.map((b) => ({ id: b.id, address: b.address, displayName: b.displayName, kind: b.kind, disabled: b.disabled })),
      box: { id: box.id, address: box.address, kind: box.kind, disabled: box.disabled },
      folder,
      view: state.view,
      label: label ? labelView(label) : null,
      filter: state.filter,
      sort: state.sort,
      q: state.q,
      searchError,
      folders: folderViews(await folderCounts(deps, me.userId, box.id)),
      labels: labels.map(labelView),
      messages: messages.map(listItem),
      reader: thread ? readerView(thread, { origin: url.origin, images: state.images }) : null,
      readerLabelIds: thread ? await messageLabelIds(deps, me.userId, thread.message.id) : [],
      receivingOff: me.isAdmin ? await receivingOffFor(box.address) : null,
      compose,
      sent: state.sent,
      proposal,
    },
  }
}

/**
 * No mailbox yet: what stands between this person and their inbox. The owner or an admin can
 * create their own mailbox right here (on a verified domain); a member is told who assigns one.
 */
async function startState(me: { userId: string; isAdmin: boolean }) {
  if (!me.isAdmin) return { canCreate: false as const }
  const admin = await mailboxAdmin(await inboxDeps(), me.userId)
  const self = admin.members.find((m) => m.id === me.userId)
  return {
    canCreate: true as const,
    domains: admin.domains.map((d) => ({ id: d.id, name: d.name })),
    suggested: self?.suggested ?? null,
  }
}

/** For the owner and admins: the mailbox's domain doesn't receive mail yet (sending already works). */
async function receivingOffFor(address: string): Promise<{ domainId: string; domain: string } | null> {
  const domainName = address.slice(address.lastIndexOf('@') + 1)
  const d = (await emailPlatform().listDomains()).find((x) => x.name === domainName)
  return d && !d.receiving ? { domainId: d.id, domain: d.name } : null
}

/** Accept / Dismiss on the mail: the calendar's rules, refused while Calendar is switched off. */
const proposalAction = (name: 'acceptProposal' | 'dismissProposal') =>
  (async ({ locals, request }) => {
    const me = await requireMember(locals)
    const form = await request.formData()
    return calendarAction(name, async () => {
      const side = await proposalSide()
      if (!(await side.calendarOn())) throw new CalendarError('forbidden', 'Calendar is switched off, so appointments from mail can’t be accepted or dismissed.')
      const actor = { kind: 'user' as const, userId: me.userId }
      const d = await side.proposalDeps()
      if (name === 'acceptProposal') return { action: name, ok: true, invited: (await acceptProposal(d, actor, field(form, 'proposalId'))).invited }
      await dismissProposal(d, actor, field(form, 'proposalId'))
      return { action: name, ok: true }
    })
  }) satisfies Actions[string]

const messageAction = (name: string, run: (userId: string, messageId: string, form: FormData) => Promise<void>) =>
  (async ({ locals, request }) => {
    const me = await requireMember(locals)
    const form = await request.formData()
    return act(name, async () => {
      const messageId = field(form, 'messageId')
      if (!isUuid(messageId)) throw new InboxError('not_found', 'No such mail.')
      await run(me.userId, messageId, form)
      return { messageId }
    })
  }) satisfies Actions[string]

/** The compose form's files (empty file inputs post a nameless empty part, which is no attachment). */
async function uploadsOf(form: FormData): Promise<Upload[]> {
  const out: Upload[] = []
  for (const v of form.getAll('attachments')) {
    if (typeof v === 'string' || (v.size === 0 && v.name === '')) continue
    out.push({ filename: v.name, contentType: v.type, bytes: new Uint8Array(await v.arrayBuffer()) })
  }
  return out
}

export const actions: Actions = {
  send: async ({ locals, request }) => {
    const me = await requireMember(locals)
    const form = await request.formData()
    return act('send', async () => {
      const mailboxId = field(form, 'mailboxId')
      if (!isUuid(mailboxId)) throw new InboxError('not_found', 'No such mailbox.')
      const mode = field(form, 'mode')
      if (!(COMPOSE_MODES as readonly string[]).includes(mode)) throw new InboxError('invalid', 'This form doesn’t say what to send.')
      const parent = field(form, 'parentId')
      if (parent !== '' && !isUuid(parent)) throw new InboxError('not_found', 'No such mail.')
      // The body keeps its own spacing: field() would trim it.
      const body = form.get('body')
      const sent = await sendMail(await sendDeps(), me.userId, {
        mailboxId,
        mode: mode as ComposeMode,
        parentId: parent === '' ? null : parent,
        to: field(form, 'to'),
        cc: field(form, 'cc'),
        bcc: field(form, 'bcc'),
        subject: field(form, 'subject'),
        body: typeof body === 'string' ? body : '',
        uploads: await uploadsOf(form),
      })
      return { sent }
    })
  },
  /** The owner or an admin gives themself a personal mailbox from the empty Inbox. */
  createMine: async ({ locals, request }) => {
    const me = await requireMember(locals)
    const form = await request.formData()
    return act('createMine', async () => {
      const box = await assignPersonalMailbox(await inboxDeps(), me.userId, {
        memberId: me.userId,
        localPart: field(form, 'localPart'),
        domainId: field(form, 'domainId'),
      })
      const receivingError = await syncMailReceiving()
      return { address: box.address, ...(receivingError ? { receivingError } : {}) }
    })
  },
  createLabel: async ({ locals, request }) => {
    const me = await requireMember(locals)
    const form = await request.formData()
    return act('createLabel', async () => {
      const mailboxId = field(form, 'mailboxId')
      if (!isUuid(mailboxId)) throw new InboxError('not_found', 'No such mailbox.')
      const label = await createLabel(await inboxDeps(), me.userId, { mailboxId, name: field(form, 'name'), color: field(form, 'color') })
      return { labelId: label.id }
    })
  },
  deleteLabel: async ({ locals, request }) => {
    const me = await requireMember(locals)
    const form = await request.formData()
    return act('deleteLabel', async () => {
      const labelId = field(form, 'labelId')
      if (!isUuid(labelId)) throw new InboxError('not_found', 'No such label.')
      await deleteLabel(await inboxDeps(), me.userId, { labelId })
      return {}
    })
  },
  label: messageAction('label', async (userId, messageId, form) => {
    const labelId = field(form, 'labelId')
    if (!isUuid(labelId)) throw new InboxError('not_found', 'No such label.')
    await setMessageLabel(await inboxDeps(), userId, { messageId, labelId, on: field(form, 'on') === '1' })
  }),
  acceptProposal: proposalAction('acceptProposal'),
  dismissProposal: proposalAction('dismissProposal'),
  read: messageAction('read', async (userId, messageId) => setRead(await inboxDeps(), userId, { messageId, read: true })),
  unread: messageAction('unread', async (userId, messageId) => setRead(await inboxDeps(), userId, { messageId, read: false })),
  star: messageAction('star', async (userId, messageId) => setStarred(await inboxDeps(), userId, { messageId, starred: true })),
  unstar: messageAction('unstar', async (userId, messageId) => setStarred(await inboxDeps(), userId, { messageId, starred: false })),
  move: messageAction('move', async (userId, messageId, form) =>
    moveMessage(await inboxDeps(), userId, { messageId, folder: field(form, 'folder') as MoveTarget }),
  ),
}
