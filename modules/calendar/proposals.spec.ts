import type { AppointmentChat } from './mail-extract'
import { describe, expect, it, vi } from 'vitest'
import { memoryProposalStore } from './proposal-store'
import {
  InvitationNotSent,
  acceptProposal,
  dismissProposal,
  openProposals,
  proposalForMail,
  scanMail,
  type InvitationMail,
  type ProposalMail,
  type ProposalMailRef,
} from './proposals'
import { getEvent, listCalendar } from './service'
import { agent, fixture, user } from './test-fixtures'

/** K7 (email → proposal) + K4 (the invitation) over the in-memory stores and a fake mail side. */

const MAIL_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_MAIL = '10000000-0000-4000-8000-000000000002'
const BOX = '20000000-0000-4000-8000-000000000001'

const answer = (json: unknown) => ({ choices: [{ message: { content: JSON.stringify(json) } }] })
const hit = {
  appointment: {
    title: 'Call with Mara Voss',
    start: '2026-11-19T15:00',
    end: '2026-11-19T15:30',
    time_zone: 'Europe/Berlin',
    location: null,
    call: 'https://meet.example/abc',
    participants: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
  },
}

function ref(over: Partial<ProposalMailRef['message']> = {}): ProposalMailRef {
  return {
    mailbox: { id: BOX, address: 'ana.lind@example.com', aliases: ['ana@example.com'] },
    message: {
      id: MAIL_ID,
      mailboxId: BOX,
      folder: 'inbox',
      subject: 'Re: Kurzer Call?',
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
      to: [{ name: 'Ana Lind', address: 'ana.lind@example.com' }],
      cc: [],
      receivedAt: new Date('2026-11-12T08:59:00Z'),
      textBody: 'Donnerstag 15 Uhr passt, Link: https://meet.example/abc',
      htmlBody: null,
      ...over,
    },
  }
}

function setup(opts: { answers?: unknown[]; mail?: Record<string, ProposalMailRef> } = {}) {
  const f = fixture()
  const proposals = memoryProposalStore()
  const mails: Record<string, ProposalMailRef> = opts.mail ?? { [`ana:${MAIL_ID}`]: ref() }
  const sent: Array<{ userId: string; mail: InvitationMail; ics: string }> = []
  let refuse: Error | null = null
  const mail: ProposalMail = {
    personalMail: async (userId, messageId) => mails[`${userId}:${messageId}`] ?? null,
    sendInvitation: async (userId, m) => {
      if (refuse) throw refuse
      sent.push({ userId, mail: m, ics: m.ics({ name: 'Ana Lind', address: 'ana.lind@example.com' }) })
    },
  }
  const queue = [...(opts.answers ?? [answer(hit)])]
  const chat = vi.fn<AppointmentChat>(async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('fake gateway has no answer queued')
    if (next instanceof Error) throw next
    return next
  })
  const deps = { calendar: f.deps, proposals, mail }
  const scanDeps = { ...deps, chat, timeZoneFor: async () => 'Europe/Berlin' }
  return { ...f, proposals, deps, scanDeps, chat, sent, refuseWith: (e: Error | null) => (refuse = e) }
}

async function filed(s: ReturnType<typeof setup>) {
  expect(await scanMail(s.scanDeps, { userId: 'ana', messageId: MAIL_ID })).toBe('filed')
  const [p] = await openProposals(s.deps, user('ana'))
  return p!
}

describe('scanning a received mail', () => {
  it('files an agreed appointment as an open proposal for the mailbox holder — nothing on the calendar yet', async () => {
    const s = setup()
    const p = await filed(s)
    expect(p).toMatchObject({
      state: 'open',
      title: 'Call with Mara Voss',
      start: '2026-11-19T14:00:00.000Z',
      end: '2026-11-19T14:30:00.000Z',
      timeZone: 'Europe/Berlin',
      localStart: '2026-11-19T15:00',
      localEnd: '2026-11-19T15:30',
      call: 'https://meet.example/abc',
      attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
      eventId: null,
      mail: { messageId: MAIL_ID, mailboxId: BOX, subject: 'Re: Kurzer Call?', from: { name: 'Mara Voss', address: 'mara@sender.example' } },
    })
    expect(await listCalendar(s.deps.calendar, user('ana'), { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' })).toEqual([])
    expect(s.events.at(-1)).toEqual({ type: 'calendar.proposal_filed', principalId: 'ana', payload: { id: p.id, messageId: MAIL_ID } })
  })

  it('gives the model the reader’s addresses and zone, on the reader’s account', async () => {
    const s = setup()
    await scanMail(s.scanDeps, { userId: 'ana', messageId: MAIL_ID })
    const call = s.chat.mock.calls[0]![0]
    expect(call.userId).toBe('ana')
    expect(call.messages[1]!.content).toContain('"addresses":["ana.lind@example.com","ana@example.com"]')
    expect(call.messages[1]!.content).toContain('Europe/Berlin')
  })

  it('files nothing when no appointment is agreed', async () => {
    const s = setup({ answers: [answer({ appointment: null })] })
    expect(await scanMail(s.scanDeps, { userId: 'ana', messageId: MAIL_ID })).toBe('none')
    expect(s.proposals.rows.size).toBe(0)
  })

  it('skips mail that is not in the holder’s own personal inbox (shared, someone else’s, gone, spam) — the model is never asked', async () => {
    const s = setup({ mail: { [`ana:${MAIL_ID}`]: ref({ folder: 'spam' }) } })
    expect(await scanMail(s.scanDeps, { userId: 'ana', messageId: MAIL_ID })).toBe('skipped')
    expect(await scanMail(s.scanDeps, { userId: 'ben', messageId: MAIL_ID })).toBe('skipped')
    expect(await scanMail(s.scanDeps, { userId: 'ana', messageId: OTHER_MAIL })).toBe('skipped')
    expect(s.chat).not.toHaveBeenCalled()
  })

  it('a mail scanned again (a retried job) files no second proposal and asks nobody', async () => {
    const s = setup({ answers: [answer(hit), answer(hit)] })
    await filed(s)
    expect(await scanMail(s.scanDeps, { userId: 'ana', messageId: MAIL_ID })).toBe('exists')
    expect(s.chat).toHaveBeenCalledTimes(1)
  })
})

describe('who sees a proposal', () => {
  it('only the mailbox holder: not a colleague, not the owner or an admin, not the agent', async () => {
    const s = setup()
    const p = await filed(s)
    expect((await proposalForMail(s.deps, user('ana'), MAIL_ID))?.id).toBe(p.id)
    for (const who of ['ben', 'olga', 'adam']) {
      expect(await openProposals(s.deps, user(who))).toEqual([])
      expect(await proposalForMail(s.deps, user(who), MAIL_ID)).toBeNull()
      await expect(acceptProposal(s.deps, user(who), p.id)).rejects.toMatchObject({ code: 'not_found' })
      await expect(dismissProposal(s.deps, user(who), p.id)).rejects.toMatchObject({ code: 'not_found' })
    }
    await expect(openProposals(s.deps, agent)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('the agent never accepts or dismisses a proposal', async () => {
    const s = setup()
    const p = await filed(s)
    await expect(acceptProposal(s.deps, agent, p.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(dismissProposal(s.deps, agent, p.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(s.sent).toEqual([])
  })

  it('a mail that is no longer in the holder’s mailbox hides its proposal', async () => {
    const s = setup()
    await filed(s)
    const gone = { ...s.deps, mail: { ...s.deps.mail, personalMail: async () => null } }
    expect(await openProposals(gone, user('ana'))).toEqual([])
    expect(await proposalForMail(gone, user('ana'), MAIL_ID)).toBeNull()
  })
})

describe('accepting', () => {
  it('creates the event (source email_proposal, the external guest) and sends the invitation from the holder’s mailbox', async () => {
    const s = setup()
    const p = await filed(s)
    const out = await acceptProposal(s.deps, user('ana'), p.id)
    expect(out.invited).toBe(1)
    const event = await getEvent(s.deps.calendar, user('ana'), out.event.id)
    expect(event).toMatchObject({
      title: 'Call with Mara Voss',
      start: '2026-11-19T14:00:00.000Z',
      end: '2026-11-19T14:30:00.000Z',
      timeZone: 'Europe/Berlin',
      location: 'https://meet.example/abc',
      source: 'email_proposal',
      attendees: [{ memberId: null, email: 'mara@sender.example', name: 'Mara Voss', role: 'required', rsvp: 'needs_action' }],
    })
    expect(s.store.events.get(out.event.id)?.externalId).toBe(MAIL_ID)
    expect(s.sent).toHaveLength(1)
    const [{ userId, mail, ics }] = s.sent as [(typeof s.sent)[number]]
    expect(userId).toBe('ana')
    expect(mail.mailboxId).toBe(BOX)
    expect(mail.to).toEqual([{ name: 'Mara Voss', address: 'mara@sender.example' }])
    expect(mail.subject).toBe('Invitation: Call with Mara Voss')
    expect(mail.text).toContain('Thursday, 19 November 2026')
    expect(mail.text).toContain('15:00 – 15:30 (Europe/Berlin)')
    const unfolded = ics.replace(/\r\n /g, '')
    expect(unfolded).toContain('METHOD:REQUEST')
    expect(unfolded).toContain(`UID:${out.event.id}@example.com`)
    expect(unfolded).toContain('DTSTART:20261119T140000Z')
    expect(unfolded).toContain('ORGANIZER;CN=Ana Lind:mailto:ana.lind@example.com')
    expect(unfolded).toContain('ATTENDEE;CN=Mara Voss;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mara@sender.example')
    expect(await proposalForMail(s.deps, user('ana'), MAIL_ID)).toMatchObject({ state: 'accepted', eventId: out.event.id })
    expect(await openProposals(s.deps, user('ana'))).toEqual([])
    expect(s.events.at(-1)).toEqual({ type: 'calendar.proposal_accepted', principalId: 'ana', payload: { id: p.id, eventId: out.event.id, invited: 1, edited: false } })
  })

  it('with the dialog’s changes: those fields, the guests as edited (only external guests get the mail)', async () => {
    const s = setup()
    const p = await filed(s)
    const out = await acceptProposal(s.deps, user('ana'), p.id, {
      title: 'Q4 call',
      allDay: false,
      start: '2026-11-19T16:00',
      end: '2026-11-19T16:45',
      timeZone: 'Europe/Berlin',
      location: '',
      notes: 'Bring the numbers',
      visibility: 'company',
      rrule: null,
      attendees: [{ memberId: 'ben' }, { email: 'mara@sender.example', name: 'Mara Voss' }, { email: 'new@sender.example' }],
    })
    expect(out.invited).toBe(2)
    expect(out.event).toMatchObject({ title: 'Q4 call', start: '2026-11-19T15:00:00.000Z', visibility: 'company', source: 'email_proposal' })
    expect(s.sent[0]!.mail.to).toEqual([
      { name: 'Mara Voss', address: 'mara@sender.example' },
      { name: null, address: 'new@sender.example' },
    ])
    expect(s.events.at(-1)?.payload).toMatchObject({ edited: true, invited: 2 })
  })

  it('without external guests nothing is sent', async () => {
    const s = setup()
    const p = await filed(s)
    const out = await acceptProposal(s.deps, user('ana'), p.id, {
      title: 'Prep',
      allDay: false,
      start: '2026-11-19T15:00',
      end: '2026-11-19T15:30',
      timeZone: 'Europe/Berlin',
      attendees: [],
    })
    expect(out.invited).toBe(0)
    expect(s.sent).toEqual([])
  })

  it('a refused invitation adds nothing: the event is removed again and the proposal stays open', async () => {
    const s = setup()
    const p = await filed(s)
    s.refuseWith(new InvitationNotSent('ana.lind@example.com is disabled, so no mail can be sent from it.'))
    await expect(acceptProposal(s.deps, user('ana'), p.id)).rejects.toMatchObject({
      code: 'upstream',
      message: expect.stringContaining('ana.lind@example.com is disabled'),
    })
    expect(s.store.events.size).toBe(0)
    expect((await openProposals(s.deps, user('ana')))[0]).toMatchObject({ id: p.id, state: 'open', eventId: null })
  })

  it('an unexpected failure also rolls back, and stays a real failure', async () => {
    const s = setup()
    const p = await filed(s)
    s.refuseWith(new Error('socket hang up'))
    await expect(acceptProposal(s.deps, user('ana'), p.id)).rejects.toThrow('socket hang up')
    expect(s.store.events.size).toBe(0)
    expect((await openProposals(s.deps, user('ana')))[0]?.state).toBe('open')
  })

  it('an invalid edit adds and sends nothing and keeps it open', async () => {
    const s = setup()
    const p = await filed(s)
    await expect(acceptProposal(s.deps, user('ana'), p.id, { title: '', allDay: false, start: 'x', end: 'y', timeZone: 'Europe/Berlin' })).rejects.toMatchObject({
      code: 'invalid',
    })
    expect(s.sent).toEqual([])
    expect((await openProposals(s.deps, user('ana')))[0]?.state).toBe('open')
  })

  it('accepting twice, or after dismissing, is refused', async () => {
    const s = setup()
    const p = await filed(s)
    await acceptProposal(s.deps, user('ana'), p.id)
    await expect(acceptProposal(s.deps, user('ana'), p.id)).rejects.toMatchObject({ code: 'invalid' })
    expect(s.sent).toHaveLength(1)
  })
})

describe('dismissing', () => {
  it('closes it without adding or sending anything', async () => {
    const s = setup()
    const p = await filed(s)
    await dismissProposal(s.deps, user('ana'), p.id)
    expect(await openProposals(s.deps, user('ana'))).toEqual([])
    expect(await proposalForMail(s.deps, user('ana'), MAIL_ID)).toMatchObject({ state: 'dismissed' })
    expect(s.store.events.size).toBe(0)
    expect(s.sent).toEqual([])
    await expect(acceptProposal(s.deps, user('ana'), p.id)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('a malformed id is not found', async () => {
    const s = setup()
    await expect(dismissProposal(s.deps, user('ana'), 'nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})
