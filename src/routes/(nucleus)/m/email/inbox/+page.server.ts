import type { MoveTarget } from '../../../../../../modules/email/inbox/types'
import type { Actions, PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { InboxError } from '../../../../../../modules/email/inbox/errors'
import { inboxDeps } from '../../../../../../modules/email/inbox/live'
import {
  folderCounts,
  getThread,
  listFolder,
  moveMessage,
  readableMailboxes,
  setRead,
  setStarred,
} from '../../../../../../modules/email/inbox/service'
import { isUuid, parseInboxQuery } from '../../../../../../modules/email/inbox/url'
import { folderViews, listItem, readerView } from '../../../../../../modules/email/inbox/view'
import { act, field, requireMember } from '../access.server'
import { INBOX_DEPENDENCY } from './dependency'

/**
 * Email › Inbox (plan/email-inbox.md §4, S4): the mailboxes you read, one
 * folder's mail, and the open thread. Everything goes through the inbox
 * service's access rule; a mailbox or mail you may not read is "not found".
 * Opening a mail does not mark it read here — the page posts ?/read.
 */
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
    return { inbox: null }
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
  const folder = state.folder ?? thread?.message.folder ?? 'inbox'

  let searchError: string | null = null
  let messages: Awaited<ReturnType<typeof listFolder>> = []
  try {
    messages = await listFolder(deps, me.userId, { mailboxId: box.id, folder, search: state.q })
  } catch (err) {
    if (!(err instanceof InboxError && err.code === 'invalid')) throw err
    searchError = err.message
  }

  return {
    inbox: {
      boxes: boxes.map((b) => ({ id: b.id, address: b.address, displayName: b.displayName, kind: b.kind, disabled: b.disabled })),
      box: { id: box.id, address: box.address, kind: box.kind, disabled: box.disabled },
      folder,
      q: state.q,
      searchError,
      folders: folderViews(await folderCounts(deps, me.userId, box.id)),
      messages: messages.map(listItem),
      reader: thread ? readerView(thread, { origin: url.origin, images: state.images }) : null,
    },
  }
}

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

export const actions: Actions = {
  read: messageAction('read', async (userId, messageId) => setRead(await inboxDeps(), userId, { messageId, read: true })),
  unread: messageAction('unread', async (userId, messageId) => setRead(await inboxDeps(), userId, { messageId, read: false })),
  star: messageAction('star', async (userId, messageId) => setStarred(await inboxDeps(), userId, { messageId, starred: true })),
  unstar: messageAction('unstar', async (userId, messageId) => setStarred(await inboxDeps(), userId, { messageId, starred: false })),
  move: messageAction('move', async (userId, messageId, form) =>
    moveMessage(await inboxDeps(), userId, { messageId, folder: field(form, 'folder') as MoveTarget }),
  ),
}
