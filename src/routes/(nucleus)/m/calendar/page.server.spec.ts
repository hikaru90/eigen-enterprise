import type { ProposalDeps, ProposalMailRef } from '../../../../../modules/calendar/proposals'
import type { CalendarDeps } from '../../../../../modules/calendar/service'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const live = vi.hoisted(() => ({ deps: null as CalendarDeps | null, proposals: null as ProposalDeps | null }))
vi.mock('../../../../../modules/calendar/live', () => ({
  calendarDeps: async () => live.deps,
  timeZoneFor: async () => 'Europe/Berlin',
}))
vi.mock('$lib/server/calendar/mail-proposals', () => ({
  proposalDeps: async () => live.proposals,
}))

import { memoryProposalStore, type ProposalRow } from '../../../../../modules/calendar/proposal-store'
import { createEvent, defaultVisibility, getEvent, listCalendar } from '../../../../../modules/calendar/service'
import { fixture, timed, user } from '../../../../../modules/calendar/test-fixtures'
import { actions, load } from './+page.server'

const MAIL = '10000000-0000-4000-8000-000000000001'
const PROPOSAL = '30000000-0000-4000-8000-000000000001'
const mailRef: ProposalMailRef = {
  mailbox: { id: 'b-1', address: 'ana.lind@example.com', aliases: [] },
  message: {
    id: MAIL,
    mailboxId: 'b-1',
    folder: 'inbox',
    subject: 'Re: Call?',
    from: { name: 'Mara Voss', address: 'mara@sender.example' },
    to: [],
    cc: [],
    receivedAt: new Date('2026-11-12T08:00:00Z'),
    textBody: null,
    htmlBody: null,
  },
}
const proposalRow: ProposalRow = {
  id: PROPOSAL,
  memberId: 'ana',
  mailboxId: 'b-1',
  messageId: MAIL,
  state: 'open',
  title: 'Call with Mara Voss',
  startsAt: new Date('2026-11-19T14:00:00Z'),
  endsAt: new Date('2026-11-19T14:30:00Z'),
  timeZone: 'Europe/Berlin',
  location: null,
  call: null,
  attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
  eventId: null,
  createdAt: new Date('2026-11-12T08:01:00Z'),
  decidedAt: null,
}

let f: ReturnType<typeof fixture>
let invitations: unknown[]
beforeEach(async () => {
  f = fixture()
  live.deps = f.deps
  invitations = []
  const proposals = memoryProposalStore()
  await proposals.insert(proposalRow)
  live.proposals = {
    calendar: f.deps,
    proposals,
    mail: {
      personalMail: async (userId, messageId) => (userId === 'ana' && messageId === MAIL ? mailRef : null),
      sendInvitation: async (_userId, mail) => void invitations.push(mail.to),
    },
  }
})

const signedIn = (id: string) => ({ user: { id, email: `${id}@test` } })
const at = (query: string) => new URL(`http://os.test/m/calendar${query}`)
const post = (entries: Array<[string, string]>) => {
  const body = new FormData()
  for (const [k, v] of entries) body.append(k, v)
  return new Request('http://os.test/m/calendar', { method: 'POST', body })
}
const NOV = { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }

type Loaded = {
  view: string
  date: string
  heading: string
  days: string[]
  timeZone: string
  occurrences: Array<{ title: string }>
  members: Array<{ id: string; name: string }>
  defaultVisibility: string
  timeZones: string[]
  availability: { selected: string[]; days: string[]; people: Array<{ memberId: string; blocks: Array<{ kind: string; title: string | null }> }> }
  proposals: Array<{ id: string; title: string }>
  editProposal: string | null
}

describe('/m/calendar', () => {
  it('sends signed-out visitors to /login', async () => {
    await expect(load({ locals: { user: null }, url: at('') } as never)).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it('shows the person’s week in their zone, colleagues to invite, and their default visibility', async () => {
    await createEvent(f.deps, user('ana'), timed('2026-11-18', '10:00', '11:00', { title: 'Planning' }))
    await createEvent(f.deps, user('ben'), timed('2026-11-18', '12:00', '13:00', { title: 'Bens own' }))
    const out = (await load({ locals: signedIn('ana'), url: at('?date=2026-11-18') } as never)) as Loaded
    expect(out).toMatchObject({ view: 'week', date: '2026-11-18', heading: '16 – 22 November 2026', timeZone: 'Europe/Berlin', defaultVisibility: 'busy' })
    expect(out.days).toHaveLength(7)
    expect(out.occurrences.map((o) => o.title)).toEqual(['Planning'])
    expect(out.members.map((m) => m.id)).toEqual(['olga', 'adam', 'ben'])
    expect(out.timeZones).toContain('Europe/Berlin')
    expect(out.availability).toEqual({ selected: [], days: out.days, people: [] })
  })

  it('shows colleagues’ availability for the picked people — busy, never the title', async () => {
    await createEvent(f.deps, user('ben'), timed('2026-11-18', '12:00', '13:00', { title: 'Bens own' }))
    const out = (await load({ locals: signedIn('ana'), url: at('?view=day&date=2026-11-18&with=ben') } as never)) as Loaded
    expect(out.availability.selected).toEqual(['ben'])
    expect(out.availability.people.map((p) => [p.memberId, p.blocks.map((b) => [b.kind, b.title])])).toEqual([['ben', [['busy', null]]]])
  })

  it('a month view covers six weeks; a bad address is a 400', async () => {
    const out = (await load({ locals: signedIn('ana'), url: at('?view=month&date=2026-11-18') } as never)) as Loaded
    expect([out.days.length, out.heading]).toEqual([42, 'November 2026'])
    await expect(load({ locals: signedIn('ana'), url: at('?view=year') } as never)).rejects.toMatchObject({ status: 400 })
    await expect(load({ locals: signedIn('ana'), url: at('?date=2026-13-01') } as never)).rejects.toMatchObject({ status: 400 })
    await expect(load({ locals: signedIn('ana'), url: at('?with=zed') } as never)).rejects.toMatchObject({ status: 400 })
  })

  it('saves a new event from the dialog, then changes it; a bad one comes back with the reason', async () => {
    const fields: Array<[string, string]> = [
      ['title', 'Call with Northwind'],
      ['startDay', '2026-11-18'],
      ['startTime', '15:00'],
      ['endDay', '2026-11-18'],
      ['endTime', '15:30'],
      ['timeZone', 'Europe/Berlin'],
      ['visibility', 'private'],
      ['repeat', 'none'],
    ]
    expect(await actions.save({ locals: signedIn('ana'), request: post(fields) } as never)).toEqual({ action: 'save', ok: true })
    const [made] = await listCalendar(f.deps, user('ana'), NOV)
    expect(made).toMatchObject({ title: 'Call with Northwind', start: '2026-11-18T14:00:00.000Z', event: { visibility: 'private' } })
    await actions.save({ locals: signedIn('ana'), request: post([...fields.filter(([k]) => k !== 'title'), ['title', 'Renamed'], ['id', made.event!.id]]) } as never)
    expect((await listCalendar(f.deps, user('ana'), NOV)).map((o) => o.title)).toEqual(['Renamed'])
    const bad = await actions.save({ locals: signedIn('ana'), request: post([...fields, ['endTime', '14:00']].filter(([k], i, a) => k !== 'endTime' || i === a.length - 1)) } as never)
    expect(bad).toMatchObject({ status: 400, data: { action: 'save', error: 'An event must end after it starts.' } })
  })

  it('deletes one instance or the event; sets the default visibility', async () => {
    const series = await createEvent(f.deps, user('ana'), timed('2026-11-02', '10:00', '10:30', { rrule: 'FREQ=WEEKLY;COUNT=3' }))
    await actions.delete({ locals: signedIn('ana'), request: post([['id', series.id], ['occurrenceStart', '2026-11-09T09:00:00.000Z']]) } as never)
    expect((await listCalendar(f.deps, user('ana'), NOV)).map((o) => o.start)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-16T09:00:00.000Z'])
    expect(await actions.delete({ locals: signedIn('ana'), request: post([['id', series.id]]) } as never)).toEqual({ action: 'delete', ok: true })
    expect(await listCalendar(f.deps, user('ana'), NOV)).toEqual([])
    expect(await actions.preferences({ locals: signedIn('ana'), request: post([['defaultVisibility', 'company']]) } as never)).toEqual({
      action: 'preferences',
      ok: true,
    })
    expect(await defaultVisibility(f.deps, user('ana'))).toBe('company')
    // Someone else's event: not found, as if it didn't exist.
    expect(await actions.delete({ locals: signedIn('ben'), request: post([['id', series.id]]) } as never)).toMatchObject({ status: 404 })
  })
})

describe('/m/calendar: appointments from mail (K7)', () => {
  it('lists the person’s open proposals — only theirs — and ?proposal= opens one for editing', async () => {
    const ana = (await load({ locals: signedIn('ana'), url: at(`?proposal=${PROPOSAL}`) } as never)) as Loaded
    expect(ana.proposals.map((p) => p.title)).toEqual(['Call with Mara Voss'])
    expect(ana.editProposal).toBe(PROPOSAL)
    const ben = (await load({ locals: signedIn('ben'), url: at('') } as never)) as Loaded
    expect(ben.proposals).toEqual([])
    await expect(load({ locals: signedIn('ben'), url: at(`?proposal=${PROPOSAL}`) } as never)).rejects.toMatchObject({ status: 404 })
  })

  it('Accept creates the event and sends the invitation; Dismiss of a decided one is refused', async () => {
    const out = await actions.acceptProposal({ locals: signedIn('ana'), request: post([['proposalId', PROPOSAL]]) } as never)
    expect(out).toEqual({ action: 'acceptProposal', ok: true, invited: 1 })
    expect(invitations).toEqual([[{ name: 'Mara Voss', address: 'mara@sender.example' }]])
    expect((await listCalendar(f.deps, user('ana'), NOV)).map((o) => [o.title, o.event?.source])).toEqual([['Call with Mara Voss', 'email_proposal']])
    expect(await actions.dismissProposal({ locals: signedIn('ana'), request: post([['proposalId', PROPOSAL]]) } as never)).toMatchObject({ status: 400 })
  })

  it('the dialog’s Save with a proposal accepts it as edited', async () => {
    const out = await actions.save({
      locals: signedIn('ana'),
      request: post([
        ['proposalId', PROPOSAL],
        ['title', 'Q4 call'],
        ['startDay', '2026-11-19'],
        ['startTime', '16:00'],
        ['endDay', '2026-11-19'],
        ['endTime', '16:30'],
        ['timeZone', 'Europe/Berlin'],
        ['visibility', 'busy'],
        ['repeat', 'none'],
        ['guestEmail', 'mara@sender.example'],
        ['guestEmailName', 'Mara Voss'],
      ]),
    } as never)
    expect(out).toEqual({ action: 'save', ok: true, invited: 1 })
    const [made] = await listCalendar(f.deps, user('ana'), NOV)
    expect(await getEvent(f.deps, user('ana'), made!.event!.id)).toMatchObject({ title: 'Q4 call', start: '2026-11-19T15:00:00.000Z', source: 'email_proposal' })
  })

  it('someone else can’t accept or dismiss it (not found)', async () => {
    expect(await actions.acceptProposal({ locals: signedIn('ben'), request: post([['proposalId', PROPOSAL]]) } as never)).toMatchObject({ status: 404 })
    expect(await actions.dismissProposal({ locals: signedIn('ben'), request: post([['proposalId', PROPOSAL]]) } as never)).toMatchObject({ status: 404 })
    expect(invitations).toEqual([])
  })
})
