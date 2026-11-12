import { describe, expect, it } from 'vitest'
import {
  assignPersonalMailbox,
  attachmentFor,
  canReadMailbox,
  createSharedMailbox,
  folderCounts,
  getThread,
  listFolder,
  moveMessage,
  setRead,
  setStarred,
} from './service'
import { fixture, message } from './test-fixtures'

/** S4: what a reader does with their mail — counts, search, threads, flags, folders. Same access rule everywhere. */

async function setup() {
  const f = fixture()
  const ana = await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })
  const sales = await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })
  return { ...f, ana, sales }
}

const at = (iso: string) => new Date(iso)

describe('folder counts', () => {
  it('counts total and unread per folder, every folder present', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm1', sesMessageId: 's1' }))
    await store.insertMessage(message(ana.id, { id: 'm2', sesMessageId: 's2', readAt: at('2026-11-12T09:00:00Z') }))
    await store.insertMessage(message(ana.id, { id: 'm3', sesMessageId: 's3', folder: 'spam' }))
    expect(await folderCounts(deps, 'ana', ana.id)).toEqual({
      inbox: { total: 2, unread: 1 },
      sent: { total: 0, unread: 0 },
      spam: { total: 1, unread: 1 },
      trash: { total: 0, unread: 0 },
      archive: { total: 0, unread: 0 },
    })
  })

  it('is not found for anyone who may not read the mailbox — the owner included', async () => {
    const { deps, ana, sales } = await setup()
    for (const who of ['olga', 'adam', 'ben', 'nobody']) {
      await expect(folderCounts(deps, who, ana.id)).rejects.toMatchObject({ code: 'not_found' })
    }
    await expect(folderCounts(deps, 'sam', sales.id)).resolves.toMatchObject({ inbox: { total: 0, unread: 0 } })
    await expect(folderCounts(deps, 'ben', sales.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('listing a folder with search', () => {
  async function mails() {
    const s = await setup()
    await s.store.insertMessage(
      message(s.ana.id, { id: 'a', sesMessageId: 'a', subject: 'Quarterly numbers', receivedAt: at('2026-11-10T00:00:00Z') }),
    )
    await s.store.insertMessage(
      message(s.ana.id, {
        id: 'b',
        sesMessageId: 'b',
        subject: 'Lunch',
        from: { name: 'Jo Berg', address: 'jo@partner.example' },
        snippet: 'Shall we meet at 100% noon?',
        receivedAt: at('2026-11-11T00:00:00Z'),
      }),
    )
    await s.store.insertMessage(message(s.ana.id, { id: 'c', sesMessageId: 'c', folder: 'archive', subject: 'Quarterly plan' }))
    return s
  }

  it('lists one folder newest first; no search lists all', async () => {
    const { deps, ana } = await mails()
    expect((await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox' })).map((m) => m.id)).toEqual(['b', 'a'])
    expect((await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'archive' })).map((m) => m.id)).toEqual(['c'])
  })

  it('searches subject, sender name, sender address and snippet, case-insensitive, within the folder', async () => {
    const { deps, ana } = await mails()
    const ids = async (search: string) => (await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', search })).map((m) => m.id)
    expect(await ids('QUARTERLY')).toEqual(['a'])
    expect(await ids('jo berg')).toEqual(['b'])
    expect(await ids('partner.example')).toEqual(['b'])
    expect(await ids('meet at')).toEqual(['b'])
    expect(await ids('mara')).toEqual(['a'])
    expect(await ids('  ')).toEqual(['b', 'a'])
  })

  it('takes the search literally: % and _ are characters, not wildcards', async () => {
    const { deps, ana } = await mails()
    expect((await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', search: '100%' })).map((m) => m.id)).toEqual(['b'])
    expect(await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', search: '%' })).toHaveLength(1)
    expect(await listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', search: '_' })).toHaveLength(0)
  })

  it('refuses a search over 200 characters', async () => {
    const { deps, ana } = await mails()
    await expect(listFolder(deps, 'ana', { mailboxId: ana.id, folder: 'inbox', search: 'x'.repeat(201) })).rejects.toMatchObject({
      code: 'invalid',
    })
  })

  it('is not found for someone else', async () => {
    const { deps, ana } = await mails()
    await expect(listFolder(deps, 'ben', { mailboxId: ana.id, folder: 'inbox' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('a thread', () => {
  it('is every mail of the thread in that mailbox, oldest first, with attachments', async () => {
    const { deps, store, ana, sales } = await setup()
    await store.insertMessage(message(ana.id, { id: 'late', sesMessageId: 'l', threadId: 't', receivedAt: at('2026-11-12T10:00:00Z') }))
    await store.insertMessage(
      message(ana.id, { id: 'early', sesMessageId: 'e', threadId: 't', folder: 'archive', receivedAt: at('2026-11-12T08:00:00Z') }),
    )
    await store.insertMessage(message(ana.id, { id: 'other', sesMessageId: 'o', threadId: 'u' }))
    await store.insertMessage(message(sales.id, { id: 'shared', sesMessageId: 'x', threadId: 't' }))
    store.attachments.set('att', {
      id: 'att',
      messageId: 'late',
      partIndex: 0,
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3,
      contentId: null,
      checksum: 'c',
      blocked: false,
      createdAt: at('2026-11-12T10:00:00Z'),
    })
    const thread = await getThread(deps, 'ana', 'late')
    expect(thread.message.id).toBe('late')
    expect(thread.messages.map((m) => m.id)).toEqual(['early', 'late'])
    expect(thread.attachments.get('late')?.map((a) => a.id)).toEqual(['att'])
    expect(thread.attachments.get('early')).toEqual([])
  })

  it('is not found for someone else, and for a mail that does not exist', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    await expect(getThread(deps, 'olga', 'm')).rejects.toMatchObject({ code: 'not_found', message: 'No such mail.' })
    await expect(getThread(deps, 'ana', 'nope')).rejects.toMatchObject({ code: 'not_found', message: 'No such mail.' })
  })
})

describe('read, star and folders', () => {
  it('marks read and unread', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    await setRead(deps, 'ana', { messageId: 'm', read: true })
    const readAt = (await store.getMessage('m'))!.readAt
    expect(readAt).toBeInstanceOf(Date)
    await setRead(deps, 'ana', { messageId: 'm', read: true })
    expect((await store.getMessage('m'))!.readAt).toEqual(readAt) // reading again keeps the first time
    await setRead(deps, 'ana', { messageId: 'm', read: false })
    expect((await store.getMessage('m'))!.readAt).toBeNull()
  })

  it('stars and unstars', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    await setStarred(deps, 'ana', { messageId: 'm', starred: true })
    expect((await store.getMessage('m'))!.starred).toBe(true)
    await setStarred(deps, 'ana', { messageId: 'm', starred: false })
    expect((await store.getMessage('m'))!.starred).toBe(false)
  })

  it('moves between inbox, archive, trash and spam; "not spam" is a move to the inbox', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    for (const folder of ['spam', 'inbox', 'archive', 'trash', 'inbox'] as const) {
      await moveMessage(deps, 'ana', { messageId: 'm', folder })
      expect((await store.getMessage('m'))!.folder).toBe(folder)
    }
  })

  it('never moves a received mail into Sent (only sending files mail there)', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    await expect(moveMessage(deps, 'ana', { messageId: 'm', folder: 'sent' as never })).rejects.toMatchObject({ code: 'invalid' })
    expect((await store.getMessage('m'))!.folder).toBe('inbox')
  })

  it('each change tells the live view (the mailbox id only)', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    await setRead(deps, 'ana', { messageId: 'm', read: true })
    await setStarred(deps, 'ana', { messageId: 'm', starred: true })
    await moveMessage(deps, 'ana', { messageId: 'm', folder: 'archive' })
    expect(store.notified).toEqual([ana.id, ana.id, ana.id])
  })

  it('nobody else can change someone’s mail — the owner included; a shared mailbox is its group’s', async () => {
    const { deps, store, ana, sales } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    await store.insertMessage(message(sales.id, { id: 'x', sesMessageId: 'x' }))
    for (const who of ['olga', 'adam', 'ben', 'sam']) {
      await expect(setRead(deps, who, { messageId: 'm', read: true })).rejects.toMatchObject({ code: 'not_found' })
      await expect(setStarred(deps, who, { messageId: 'm', starred: true })).rejects.toMatchObject({ code: 'not_found' })
      await expect(moveMessage(deps, who, { messageId: 'm', folder: 'trash' })).rejects.toMatchObject({ code: 'not_found' })
    }
    expect(await store.getMessage('m')).toMatchObject({ readAt: null, starred: false, folder: 'inbox' })
    await moveMessage(deps, 'sam', { messageId: 'x', folder: 'archive' })
    await expect(moveMessage(deps, 'ben', { messageId: 'x', folder: 'inbox' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('who may read a mailbox (the live stream asks per event)', () => {
  it('is the personal mailbox’s member and the shared mailbox’s group, nobody else', async () => {
    const { deps, ana, sales } = await setup()
    expect(await canReadMailbox(deps, 'ana', ana.id)).toBe(true)
    expect(await canReadMailbox(deps, 'olga', ana.id)).toBe(false)
    expect(await canReadMailbox(deps, 'sam', sales.id)).toBe(true)
    expect(await canReadMailbox(deps, 'ben', sales.id)).toBe(false)
    expect(await canReadMailbox(deps, 'ana', 'no-such-box')).toBe(false)
    expect(await canReadMailbox(deps, 'gone', ana.id)).toBe(false)
  })
})

describe('an attachment', () => {
  it('comes with its message for a reader; not found for anyone else', async () => {
    const { deps, store, ana } = await setup()
    await store.insertMessage(message(ana.id, { id: 'm', sesMessageId: 'm' }))
    store.attachments.set('att', {
      id: 'att',
      messageId: 'm',
      partIndex: 0,
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 3,
      contentId: null,
      checksum: 'c',
      blocked: false,
      createdAt: at('2026-11-12T10:00:00Z'),
    })
    const out = await attachmentFor(deps, 'ana', 'att')
    expect(out.attachment.id).toBe('att')
    expect(out.message.id).toBe('m')
    await expect(attachmentFor(deps, 'olga', 'att')).rejects.toMatchObject({ code: 'not_found' })
    await expect(attachmentFor(deps, 'ana', 'nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})
