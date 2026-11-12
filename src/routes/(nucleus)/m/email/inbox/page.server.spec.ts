import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assignPersonalMailbox, createSharedMailbox } from '../../../../../../modules/email/inbox/service'
import { fixture, message } from '../../../../../../modules/email/inbox/test-fixtures'

/** Email › Inbox over the real inbox service on the in-memory store. */

let f = fixture()
let me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }

let sent: Array<{ fromAddress: string; recipients: unknown }> = []
vi.mock('../../../../../../modules/email/inbox/live', () => ({
  inboxDeps: async () => f.deps,
  sendDeps: async () => ({
    inbox: f.deps,
    transport: {
      sendMailboxMail: async (input: { fromAddress: string; recipients: unknown }) => {
        sent.push(input)
        return { sesMessageId: `ses-${sent.length}` }
      },
    },
    raw: { getRaw: async () => { throw new Error('no raw mail in this test') } },
    bucket: async () => 'bucket',
  }),
}))
vi.mock('../access.server', async (orig) => {
  const real = await orig<typeof import('../access.server')>()
  return { ...real, requireMember: vi.fn(async () => me) }
})

const { load, actions } = await import('./+page.server')

const M1 = '10000000-0000-4000-8000-000000000001'
const M2 = '10000000-0000-4000-8000-000000000002'
const M3 = '10000000-0000-4000-8000-000000000003'

type Inbox = {
  boxes: Array<{ id: string; address: string }>
  box: { id: string; address: string }
  folder: string
  q: string | null
  searchError: string | null
  folders: Array<{ folder: string; total: number; unread: number }>
  messages: Array<{ id: string; unread: boolean }>
  reader: { id: string; messages: Array<{ id: string }>; imagesShown: boolean } | null
  compose: { mode: string; fromMailboxId: string | null; to: string; subject: string; parentId: string | null } | null
  sent: boolean
}

const run = async (query = '') => {
  const depends = vi.fn()
  const out = (await load({ locals: {}, url: new URL(`https://os.example.com/m/email/inbox${query}`), depends } as never)) as {
    inbox: Inbox | null
  }
  return { inbox: out.inbox, depends }
}
const status = async (query: string) => {
  try {
    await run(query)
    return 200
  } catch (err) {
    return (err as { status?: number }).status
  }
}
const post = (name: keyof typeof actions, fields: Record<string, string>, files: File[] = []) => {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  for (const file of files) body.append('attachments', file)
  return actions[name]({ locals: {}, request: new Request('http://x/', { method: 'POST', body }) } as never)
}

let anaBox = ''
let salesBox = ''

beforeEach(async () => {
  f = fixture()
  sent = []
  me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }
  anaBox = (await assignPersonalMailbox(f.deps, 'olga', { memberId: 'ana', localPart: 'ana.lind', domainId: 'd-1' })).id
  salesBox = (await createSharedMailbox(f.deps, 'olga', { groupId: 'g-sales', localPart: 'sales', domainId: 'd-1' })).id
  await f.store.insertMessage(message(anaBox, { id: M1, sesMessageId: 'a', threadId: 't', subject: 'Numbers', receivedAt: new Date('2026-11-12T08:00:00Z') }))
  await f.store.insertMessage(message(anaBox, { id: M2, sesMessageId: 'b', threadId: 't', subject: 'Re: Numbers', receivedAt: new Date('2026-11-12T09:00:00Z') }))
  await f.store.insertMessage(message(salesBox, { id: M3, sesMessageId: 'c', threadId: 'u', subject: 'Lead', folder: 'spam' }))
})

describe('Email › Inbox load', () => {
  it('opens your personal mailbox’s inbox first and depends on the live key', async () => {
    const { inbox, depends } = await run()
    expect(depends).toHaveBeenCalledWith('app:email-inbox')
    expect(inbox!.boxes.map((b) => b.address)).toEqual(['ana.lind@example.com', 'sales@example.com'])
    expect(inbox!.box.address).toBe('ana.lind@example.com')
    expect(inbox!.folder).toBe('inbox')
    expect(inbox!.messages.map((m) => m.id)).toEqual([M2, M1])
    expect(inbox!.folders.find((x) => x.folder === 'inbox')).toEqual({ folder: 'inbox', label: 'Inbox', total: 2, unread: 2 })
    expect(inbox!.reader).toBeNull()
  })

  it('switches mailbox and folder from the URL, and searches', async () => {
    expect((await run(`?box=${salesBox}&folder=spam`)).inbox!.messages.map((m) => m.id)).toEqual([M3])
    const searched = (await run(`?q=re%3A`)).inbox!
    expect(searched.q).toBe('re:')
    expect(searched.messages.map((m) => m.id)).toEqual([M2])
    expect((await run(`?q=${'x'.repeat(201)}`)).inbox!.searchError).toMatch(/under 200/)
  })

  it('opens a thread without marking it read, in the mail’s own mailbox and folder', async () => {
    const { inbox } = await run(`?m=${M3}`)
    expect(inbox!.box.id).toBe(salesBox)
    expect(inbox!.folder).toBe('spam')
    expect(inbox!.reader).toMatchObject({ id: M3, imagesShown: false })
    expect((await run(`?m=${M2}&images=1`)).inbox!.reader!.messages.map((m) => m.id)).toEqual([M1, M2])
    expect((await f.store.getMessage(M2))!.readAt).toBeNull()
  })

  it('answers not found for someone else’s mailbox or mail, the owner included, and for junk in the URL', async () => {
    me = { userId: 'olga', email: 'olga@home.example', isAdmin: true }
    expect(await run()).toEqual({ inbox: null, depends: expect.any(Function) })
    expect(await status(`?m=${M1}`)).toBe(404)
    expect(await status(`?box=${anaBox}`)).toBe(404)
    me = { userId: 'ben', email: 'ben@home.example', isAdmin: false }
    expect(await status(`?m=${M3}`)).toBe(404)
    me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }
    expect(await status(`?box=${anaBox}&m=${M3}`)).toBe(404)
    expect(await status('?folder=drafts')).toBe(404)
    expect(await status('?m=not-a-uuid')).toBe(404)
  })

  it('a member with no mailbox gets none (the page explains who assigns one)', async () => {
    me = { userId: 'adam', email: 'adam@home.example', isAdmin: true }
    expect((await run()).inbox).toBeNull()
  })
})

describe('Email › Inbox actions', () => {
  it('reads, unreads, stars, and moves (spam → not spam)', async () => {
    expect(await post('read', { messageId: M1 })).toEqual({ action: 'read', ok: true, messageId: M1 })
    expect((await f.store.getMessage(M1))!.readAt).not.toBeNull()
    await post('unread', { messageId: M1 })
    expect((await f.store.getMessage(M1))!.readAt).toBeNull()
    await post('star', { messageId: M1 })
    expect((await f.store.getMessage(M1))!.starred).toBe(true)
    await post('unstar', { messageId: M1 })
    expect((await f.store.getMessage(M1))!.starred).toBe(false)
    await post('move', { messageId: M1, folder: 'spam' })
    expect((await run('?folder=spam')).inbox!.messages.map((m) => m.id)).toEqual([M1])
    await post('move', { messageId: M1, folder: 'inbox' })
    expect((await f.store.getMessage(M1))!.folder).toBe('inbox')
  })

  it('refuses someone else’s mail and unknown folders with a plain message', async () => {
    me = { userId: 'olga', email: 'olga@home.example', isAdmin: true }
    expect(await post('read', { messageId: M1 })).toMatchObject({ status: 400, data: { action: 'read', error: 'No such mail.' } })
    expect(await post('move', { messageId: 'nope', folder: 'trash' })).toMatchObject({ status: 400, data: { error: 'No such mail.' } })
    me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }
    expect(await post('move', { messageId: M1, folder: 'sent' })).toMatchObject({ status: 400 })
    expect((await f.store.getMessage(M1))!).toMatchObject({ readAt: null, folder: 'inbox' })
  })
})

describe('Email › Inbox compose (S5)', () => {
  it('opens the compose form for new mail and prefilled for a reply of the opened mail', async () => {
    expect((await run()).inbox!.compose).toBeNull()
    expect((await run('?compose=new')).inbox!.compose).toMatchObject({ mode: 'new', fromMailboxId: anaBox, to: '', parentId: null })
    expect((await run(`?m=${M1}&compose=reply`)).inbox!.compose).toMatchObject({
      mode: 'reply',
      fromMailboxId: anaBox,
      to: 'Mara Voss <mara@sender.example>',
      subject: 'Re: Numbers',
      parentId: M1,
    })
    expect(await status('?compose=reply')).toBe(404)
    expect((await run(`?m=${M1}&sent=1`)).inbox!.sent).toBe(true)
  })

  it('sends from a mailbox you read and files the copy in Sent', async () => {
    const out = (await post(
      'send',
      { mailboxId: anaBox, mode: 'reply', parentId: M1, to: 'mara@sender.example', cc: '', bcc: '', subject: 'Re: Numbers', body: '  Thanks!\n' },
      [new File(['hello'], 'notes.txt', { type: 'text/plain' }), new File([], '')],
    )) as { ok: boolean; sent: { id: string; threadId: string; mailboxId: string } }
    expect(out).toMatchObject({ action: 'send', ok: true, sent: { mailboxId: anaBox, threadId: 't' } })
    expect(sent).toEqual([{ fromAddress: 'ana.lind@example.com', recipients: { to: ['mara@sender.example'], cc: [], bcc: [] }, raw: expect.any(Uint8Array) }])
    const copy = (await f.store.getMessage(out.sent.id))!
    expect(copy).toMatchObject({ folder: 'sent', textBody: '  Thanks!\n', subject: 'Re: Numbers' })
    expect((await f.store.listAttachments(copy.id)).map((a) => a.filename)).toEqual(['notes.txt'])
  })

  it('refuses in plain words: someone else’s mailbox, a disabled one, bad recipients — nothing sent', async () => {
    const fields = { mailboxId: anaBox, mode: 'new', parentId: '', to: 'mara@sender.example', cc: '', bcc: '', subject: 'Hi', body: 'Hi' }
    me = { userId: 'olga', email: 'olga@home.example', isAdmin: true }
    expect(await post('send', fields)).toMatchObject({ status: 400, data: { action: 'send', error: 'No such mailbox.' } })
    me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }
    expect(await post('send', { ...fields, to: 'nope' })).toMatchObject({ status: 400, data: { error: expect.stringMatching(/“nope” in To/) } })
    expect(await post('send', { ...fields, mode: 'draft' })).toMatchObject({ status: 400 })
    await f.store.updateMailbox(anaBox, { disabledAt: new Date(), updatedAt: new Date() })
    expect(await post('send', fields)).toMatchObject({ status: 400, data: { error: 'ana.lind@example.com is disabled, so no mail can be sent from it.' } })
    expect(sent).toEqual([])
  })
})
