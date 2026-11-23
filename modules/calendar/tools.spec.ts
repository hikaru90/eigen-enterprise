import type { ProposalDeps, ProposalMailRef } from './proposals'
import type { FreeBusyDto, OccurrenceDto } from './types'
import { describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import type { ToolContext } from '$lib/kernel/types'
import { CALENDAR_TOOL_NAMES, CALENDAR_WRITE_TOOLS } from './manifest'
import { memoryProposalStore } from './proposal-store'
import { createEvent, defaultVisibility, listCalendar } from './service'
import { fixture, timed, user } from './test-fixtures'
import { createCalendarTools } from './tools'

/** An agent principal that is no person (an API key of no member). */
const agentCtx: ToolContext = {
  principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'r1',
}
/** The company brain acting as this member (CB3: the principal IS the person). */
const brainFor = (id: string): ToolContext => ({
  principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
  requestId: 'r3',
})
const humanCtx = (id: string): ToolContext => ({
  principal: { id, kind: 'human', roles: ['admin'] },
  requestId: 'r2',
})

async function setup(opts: { agentPerson?: string | null } = {}) {
  const f = fixture()
  await createEvent(
    f.deps,
    user('ana'),
    timed('2026-11-16', '10:00', '11:00', { title: 'Doctor', visibility: 'private' }),
  )
  await createEvent(
    f.deps,
    user('ben'),
    timed('2026-11-16', '12:00', '13:00', { title: 'Lunch with Mara' }),
  )
  const proposals = memoryProposalStore()
  const sent: string[] = []
  const mailRef: ProposalMailRef = {
    mailbox: { id: BOX, address: 'ana.lind@example.com', aliases: [] },
    message: {
      id: MAIL_ID,
      mailboxId: BOX,
      folder: 'inbox',
      subject: 'Re: Call?',
      from: { name: 'Mara Voss', address: 'mara@sender.example' },
      to: [{ name: 'Ana Lind', address: 'ana.lind@example.com' }],
      cc: [],
      receivedAt: new Date('2026-11-12T08:59:00Z'),
      textBody: 'Thursday 15:00 works',
      htmlBody: null,
    },
  }
  const pdeps: ProposalDeps = {
    calendar: f.deps,
    proposals,
    mail: {
      personalMail: async (userId, messageId) =>
        userId === 'ana' && messageId === MAIL_ID ? mailRef : null,
      sendInvitation: async (_userId, m) => {
        sent.push(...m.to.map((t) => t.address))
      },
    },
  }
  const list = createCalendarTools({
    deps: async () => f.deps,
    proposalDeps: async () => pdeps,
    agentPerson: async () => opts.agentPerson ?? null,
    now: () => new Date('2026-11-15T08:00:00Z'),
  })
  return { f, proposals, sent, tools: Object.fromEntries(list.map((t) => [t.name, t])) }
}

const MAIL_ID = '10000000-0000-4000-8000-000000000001'
const BOX = '20000000-0000-4000-8000-000000000001'

async function fileProposal(s: Awaited<ReturnType<typeof setup>>) {
  await s.proposals.insert({
    id: '30000000-0000-4000-8000-000000000001',
    memberId: 'ana',
    mailboxId: BOX,
    messageId: MAIL_ID,
    state: 'open',
    title: 'Call with Mara Voss',
    startsAt: new Date('2026-11-19T14:00:00Z'),
    endsAt: new Date('2026-11-19T14:30:00Z'),
    timeZone: 'Europe/Berlin',
    location: null,
    call: null,
    attendees: [{ email: 'mara@sender.example', name: 'Mara Voss' }],
    eventId: null,
    createdAt: new Date('2026-11-12T09:00:00Z'),
    decidedAt: null,
  })
  return '30000000-0000-4000-8000-000000000001'
}

const week = { from: '2026-11-16T00:00:00Z', to: '2026-11-23T00:00:00Z' }

type ListOut = { from: string; to: string; occurrences: OccurrenceDto[] }

describe('calendar.* tools', () => {
  it('match the manifest; reads are reads, every write is approval-gated', async () => {
    expect(createCalendarTools().map((t) => t.name)).toEqual([...CALENDAR_TOOL_NAMES])
    const { tools } = await setup()
    for (const name of ['calendar.list', 'calendar.free_busy', 'calendar.proposals'])
      expect(tools[name].auditClass).toBe('read')
    for (const name of CALENDAR_WRITE_TOOLS) {
      expect(tools[name].auditClass).not.toBe('read')
      expect(tools[name].approvalRisk).toBeDefined()
    }
    expect(tools['calendar.accept_proposal']).toMatchObject({
      auditClass: 'external',
      approvalRisk: 'external',
    })
  })

  it('create, change one occurrence, change the series, delete one occurrence, delete the series — as the person', async () => {
    const { f, tools } = await setup()
    const ctx = brainFor('ben')
    const { event } = (await tools['calendar.create_event'].handler(ctx, {
      title: 'Standup',
      all_day: false,
      start: '2026-11-16T09:00',
      end: '2026-11-16T09:15',
      time_zone: 'Europe/Berlin',
      rrule: 'FREQ=DAILY;COUNT=3',
      attendees: [{ member_id: 'ana' }, { email: 'guest@outside.example', name: 'Gus' }],
      visibility: 'company',
    })) as { event: { id: string; ownerId: string; attendees: unknown[] } }
    expect(event.ownerId).toBe('ben')
    expect(event.attendees).toHaveLength(2)
    const titles = async () =>
      (await listCalendar(f.deps, user('ben'), week)).map((o) => `${o.start} ${o.title}`)
    expect(await titles()).toHaveLength(4) // three standups + lunch

    await tools['calendar.update_event'].handler(ctx, {
      id: event.id,
      occurrence_start: '2026-11-17T08:00:00.000Z',
      title: 'Standup (moved topic)',
    })
    expect(await titles()).toContain('2026-11-17T08:00:00.000Z Standup (moved topic)')
    await tools['calendar.update_event'].handler(ctx, { id: event.id, title: 'Daily' })
    expect(await titles()).toContain('2026-11-16T08:00:00.000Z Daily')

    await tools['calendar.delete_event'].handler(ctx, {
      id: event.id,
      occurrence_start: '2026-11-18T08:00:00.000Z',
    })
    expect((await titles()).some((t) => t.startsWith('2026-11-18T08:00'))).toBe(false)
    expect(await tools['calendar.delete_event'].handler(ctx, { id: event.id })).toEqual({
      deleted: event.id,
    })
    expect((await titles()).filter((t) => t.includes('Daily'))).toEqual([])
  })

  it('a person cannot change someone else’s event; an agent that is no person has no calendar to write', async () => {
    const { f, tools } = await setup()
    const [lunch] = await listCalendar(f.deps, user('ben'), week)
    await expect(
      tools['calendar.update_event'].handler(humanCtx('ana'), {
        id: lunch!.event!.id,
        title: 'Mine now',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      tools['calendar.create_event'].handler(agentCtx, {
        title: 'X',
        all_day: false,
        start: '2026-11-16T09:00',
        end: '2026-11-16T10:00',
        time_zone: 'UTC',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('sets the person’s default visibility of new events', async () => {
    const { f, tools } = await setup()
    expect(
      await tools['calendar.set_default_visibility'].handler(humanCtx('ana'), {
        visibility: 'company',
      }),
    ).toEqual({ visibility: 'company' })
    expect(await defaultVisibility(f.deps, user('ana'))).toBe('company')
    await expect(
      tools['calendar.set_default_visibility'].handler(humanCtx('ana'), { visibility: 'public' }),
    ).rejects.toThrow()
  })

  it('appointments found in mail: listed for their holder only, accepted (with edits, invitation sent) or dismissed', async () => {
    const s = await setup()
    const id = await fileProposal(s)
    const { proposals } = (await s.tools['calendar.proposals'].handler(humanCtx('ana'), {})) as {
      proposals: Array<{ id: string }>
    }
    expect(proposals.map((p) => p.id)).toEqual([id])
    expect(await s.tools['calendar.proposals'].handler(humanCtx('ben'), {})).toEqual({
      proposals: [],
    })

    const out = (await s.tools['calendar.accept_proposal'].handler(humanCtx('ana'), {
      proposal_id: id,
      event: {
        title: 'Call with Mara',
        all_day: false,
        start: '2026-11-19T16:00',
        end: '2026-11-19T16:30',
        time_zone: 'Europe/Berlin',
        attendees: [{ email: 'mara@sender.example' }],
      },
    })) as { event: { title: string; start: string }; invited: number }
    expect(out).toMatchObject({
      event: { title: 'Call with Mara', start: '2026-11-19T15:00:00.000Z' },
      invited: 1,
    })
    expect(s.sent).toEqual(['mara@sender.example'])
    await expect(
      s.tools['calendar.dismiss_proposal'].handler(humanCtx('ana'), { proposal_id: id }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })

  it('dismisses an appointment found in mail; nothing is added', async () => {
    const s = await setup()
    const id = await fileProposal(s)
    await expect(
      s.tools['calendar.dismiss_proposal'].handler(humanCtx('ben'), { proposal_id: id }),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(
      await s.tools['calendar.dismiss_proposal'].handler(humanCtx('ana'), { proposal_id: id }),
    ).toEqual({ dismissed: id })
    expect(await s.tools['calendar.proposals'].handler(humanCtx('ana'), {})).toEqual({
      proposals: [],
    })
    expect(s.sent).toEqual([])
  })

  it('calendar.list is the person’s own calendar — the brain acting as Ben sees Ben’s, not Ana’s', async () => {
    const { tools } = await setup()
    const out = (await tools['calendar.list'].handler(brainFor('ben'), {})) as ListOut
    // Defaults: from the start of today (UTC) for 7 days.
    expect([out.from, out.to]).toEqual(['2026-11-15T00:00:00.000Z', '2026-11-22T00:00:00.000Z'])
    expect(out.occurrences.map((o) => o.title)).toEqual(['Lunch with Mara'])
    const ana = (await tools['calendar.list'].handler(humanCtx('ana'), {
      from: '2026-11-16T00:00:00Z',
      to: '2026-11-17T00:00:00Z',
    })) as ListOut
    expect(ana.occurrences.map((o) => o.title)).toEqual(['Doctor'])
  })

  it('an agent key that belongs to a person is that person', async () => {
    const { tools } = await setup({ agentPerson: 'ben' })
    const out = (await tools['calendar.list'].handler(agentCtx, {})) as ListOut
    expect(out.occurrences.map((o) => o.title)).toEqual(['Lunch with Mara'])
  })

  it('an agent principal that is no person has no calendar to list', async () => {
    const { tools } = await setup()
    await expect(tools['calendar.list'].handler(agentCtx, {})).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('calendar.free_busy shows colleagues’ time with the visibility labels, never private titles', async () => {
    const { tools } = await setup()
    const out = (await tools['calendar.free_busy'].handler(brainFor('ben'), {
      member_ids: ['ana', 'ben'],
      from: '2026-11-16T00:00:00Z',
      to: '2026-11-17T00:00:00Z',
    })) as { people: FreeBusyDto[] }
    expect(out.people.map((p) => [p.name, p.blocks.map((b) => [b.kind, b.title])])).toEqual([
      ['Ana Lind', [['out_of_office', null]]],
      ['Ben Ode', [['busy', null]]],
    ])
    expect(JSON.stringify(out)).not.toContain('Doctor')
  })

  it('rejects unknown keys and bad ranges', async () => {
    const { tools } = await setup()
    await expect(
      tools['calendar.list'].handler(humanCtx('ana'), { owner: 'ben' }),
    ).rejects.toThrow()
    await expect(
      tools['calendar.free_busy'].handler(humanCtx('ana'), {
        member_ids: ['ben'],
        from: '2026-11-16T00:00:00Z',
      }),
    ).rejects.toThrow()
  })
})
