import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
/** Calendar K7: the proposal side over the calendar's in-memory stores; Calendar is on in the K7 tests only. */
const cal = vi.hoisted(() => ({ on: false, deps: null as unknown }))
vi.mock('$lib/server/calendar/mail-proposals', () => ({
  calendarOn: async () => cal.on,
  proposalDeps: async () => cal.deps,
}))
/** The platform side: which domains receive mail (the owner's "receiving is off" note) and the receipt-rule sync. */
const platform = vi.hoisted(() => ({ domains: [] as Array<{ id: string; name: string; receiving: boolean }>, synced: 0 }))
vi.mock('../../../../../../modules/email/platform/service', async (orig) => ({
  ...(await orig<typeof import('../../../../../../modules/email/platform/service')>()),
  emailPlatform: () => ({ listDomains: async () => platform.domains }),
}))
vi.mock('../../../../../../modules/email/platform/receiving-sync', () => ({
  syncMailReceiving: async () => {
    platform.synced++
    return null
  },
}))
vi.mock('../access.server', async (orig) => {
  const real = await orig<typeof import('../access.server')>()
  return { ...real, requireMember: vi.fn(async () => me) }
})

const { load, actions } = await import('./+page.server')
const { fixture: calendarFixture } = await import('../../../../../../modules/calendar/test-fixtures')
const { memoryProposalStore } = await import('../../../../../../modules/calendar/proposal-store')

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
  proposal: { id: string; state: string; title: string } | null
}

const run = async (query = '') => {
  const depends = vi.fn()
  const out = (await load({ locals: {}, url: new URL(`https://os.example.com/m/email/inbox${query}`), depends } as never)) as {
    inbox: Inbox | null
    start: { canCreate: boolean; domains?: Array<{ id: string; name: string }>; suggested?: string | null } | null
  }
  return { inbox: out.inbox, start: out.start, depends }
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
  platform.domains = []
  platform.synced = 0
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
    expect(await run()).toMatchObject({ inbox: null, start: { canCreate: true } })
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
    me = { userId: 'ben', email: 'ben@home.example', isAdmin: false }
    expect(await run()).toMatchObject({ inbox: null, start: { canCreate: false } })
  })

  it('an admin with no mailbox can create their own on a verified domain, right from the Inbox', async () => {
    me = { userId: 'adam', email: 'adam@home.example', isAdmin: true }
    expect((await run()).start).toEqual({ canCreate: true, domains: [{ id: 'd-1', name: 'example.com' }], suggested: 'adam.admin' })
    expect(await post('createMine', { localPart: 'adam', domainId: 'd-1' })).toMatchObject({ ok: true, address: 'adam@example.com' })
    expect(platform.synced).toBe(1)
    const { inbox, start } = await run()
    expect(start).toBeNull()
    expect(inbox!.box.address).toBe('adam@example.com')
    // A member can't create one this way.
    me = { userId: 'ben', email: 'ben@home.example', isAdmin: false }
    await expect(post('createMine', { localPart: 'ben', domainId: 'd-1' })).resolves.toMatchObject({ status: 400 })
  })

  it('tells the owner when the mailbox’s domain does not receive mail yet', async () => {
    me = { userId: 'ana', email: 'ana@home.example', isAdmin: true }
    platform.domains = [{ id: 'dom', name: 'example.com', receiving: false }]
    expect(((await run()).inbox as unknown as { receivingOff: unknown }).receivingOff).toEqual({ domainId: 'dom', domain: 'example.com' })
    platform.domains = [{ id: 'dom', name: 'example.com', receiving: true }]
    expect(((await run()).inbox as unknown as { receivingOff: unknown }).receivingOff).toBeNull()
  })

  it('labels: create, put on a mail, list by label, filter and sort from the URL, remove', async () => {
    expect(await post('createLabel', { mailboxId: anaBox, name: 'Clients', color: 'sage' })).toMatchObject({ ok: true })
    const { inbox } = await run()
    const label = (inbox as unknown as { labels: Array<{ id: string; name: string }> }).labels[0]!
    expect(label.name).toBe('Clients')
    expect(await post('label', { messageId: M1, labelId: label.id, on: '1' })).toMatchObject({ ok: true })
    const byLabel = (await run(`?label=${label.id}`)).inbox!
    expect(byLabel.messages.map((m) => m.id)).toEqual([M1])
    expect(byLabel.folder).toBeNull()
    const opened = (await run(`?label=${label.id}&m=${M1}`)).inbox as unknown as { readerLabelIds: string[] }
    expect(opened.readerLabelIds).toEqual([label.id])
    expect((await run('?sort=oldest')).inbox!.messages.map((m) => m.id)).toEqual([M1, M2])
    expect((await run('?filter=unread')).inbox!.messages.map((m) => m.id)).toEqual([M2, M1])
    expect(await status(`?label=10000000-0000-4000-8000-0000000000ff`)).toBe(404)
    // Someone else's label can't go on your mail.
    await expect(post('label', { messageId: M1, labelId: 'not-a-uuid', on: '1' })).resolves.toMatchObject({ status: 400 })
    expect(await post('deleteLabel', { labelId: label.id })).toMatchObject({ ok: true })
    expect(await status(`?label=${label.id}`)).toBe(404)
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

describe('Email › Inbox: an appointment found in the opened mail (calendar K7)', () => {
  const PROPOSAL = '30000000-0000-4000-8000-000000000001'
  let invitations: unknown[] = []

  beforeEach(async () => {
    cal.on = true
    invitations = []
    const c = calendarFixture()
    const proposals = memoryProposalStore()
    await proposals.insert({
      id: PROPOSAL,
      memberId: 'ana',
      mailboxId: anaBox,
      messageId: M2,
      state: 'open',
      title: 'Call with Mara Voss',
      startsAt: new Date('2026-11-19T14:00:00Z'),
      endsAt: new Date('2026-11-19T14:30:00Z'),
      timeZone: 'Europe/Berlin',
      location: null,
      call: null,
      attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
      eventId: null,
      createdAt: new Date('2026-11-12T09:01:00Z'),
      decidedAt: null,
    })
    const mail = await f.store.getMessage(M2)
    cal.deps = {
      calendar: c.deps,
      proposals,
      mail: {
        personalMail: async (userId: string, messageId: string) =>
          userId === 'ana' && messageId === M2 ? { mailbox: { id: anaBox, address: 'ana.lind@example.com', aliases: [] }, message: mail } : null,
        sendInvitation: async (_u: string, m: { to: unknown }) => void invitations.push(m.to),
      },
    }
  })
  afterEach(() => {
    cal.on = false
  })

  it('shows on that mail for its holder, not on others', async () => {
    expect((await run(`?m=${M2}`)).inbox!.proposal).toMatchObject({ id: PROPOSAL, state: 'open', title: 'Call with Mara Voss' })
    expect((await run(`?m=${M1}`)).inbox!.proposal).toBeNull()
    expect((await run()).inbox!.proposal).toBeNull()
  })

  it('shows nothing while Calendar is switched off, and Accept is refused then', async () => {
    cal.on = false
    expect((await run(`?m=${M2}`)).inbox!.proposal).toBeNull()
    expect(await post('acceptProposal', { proposalId: PROPOSAL })).toMatchObject({ status: 403 })
    expect(invitations).toEqual([])
  })

  it('Accept adds it and sends the invitation; the mail then says so', async () => {
    expect(await post('acceptProposal', { proposalId: PROPOSAL })).toEqual({ action: 'acceptProposal', ok: true, invited: 1 })
    expect(invitations).toEqual([[{ name: 'Mara Voss', address: 'mara@sender.example' }]])
    expect((await run(`?m=${M2}`)).inbox!.proposal).toMatchObject({ state: 'accepted' })
  })

  it('Dismiss closes it; someone else can’t touch it', async () => {
    me = { userId: 'ben', email: 'ben@home.example', isAdmin: false }
    expect(await post('dismissProposal', { proposalId: PROPOSAL })).toMatchObject({ status: 404 })
    me = { userId: 'ana', email: 'ana@home.example', isAdmin: false }
    expect(await post('dismissProposal', { proposalId: PROPOSAL })).toEqual({ action: 'dismissProposal', ok: true })
    expect((await run(`?m=${M2}`)).inbox!.proposal).toMatchObject({ state: 'dismissed' })
  })
})
