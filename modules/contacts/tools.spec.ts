import type { ContactDto, FollowUpDto, Pipeline } from './types'
import { describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import type { ToolContext } from '$lib/kernel/types'
import { CONTACTS_TOOL_NAMES } from './manifest'
import { createContact } from './service'
import { fixture, user } from './test-fixtures'
import { createContactsTools } from './tools'

/** An agent principal that is no person (an API key of no member). */
const agentCtx: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r1' }
/** The company brain acting as this member (CB3: the principal IS the person). */
const brainFor = (id: string): ToolContext => ({ principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'), requestId: 'r3' })
const humanCtx = (id: string): ToolContext => ({ principal: { id, kind: 'human', roles: ['admin'] }, requestId: 'r2' })

async function setup(opts: { agentPerson?: string | null } = {}) {
  const f = fixture()
  const anasPrivate = await createContact(f.deps, user('ana'), { name: 'Mara Voss', tags: ['investor'], nextFollowUpOn: '2026-11-13' })
  const bensPrivate = await createContact(f.deps, user('ben'), { name: 'Jon Park', nextFollowUpOn: '2026-11-14' })
  const list = createContactsTools({
    deps: async () => f.deps,
    agentPerson: async () => opts.agentPerson ?? null,
    today: () => '2026-11-12',
  })
  const tools = Object.fromEntries(list.map((t) => [t.name, t]))
  return { f, tools, anasPrivate, bensPrivate }
}

describe('contacts.* tools', () => {
  it('match the manifest', () => {
    expect(createContactsTools().map((t) => t.name)).toEqual([...CONTACTS_TOOL_NAMES])
  })

  it('reads are read-class; writes are mutate-class, internal-risk and say what they did without naming the person', async () => {
    const { tools } = await setup()
    for (const name of ['contacts.list', 'contacts.get', 'contacts.follow_ups', 'contacts.pipeline']) expect(tools[name].auditClass).toBe('read')
    for (const name of ['contacts.create', 'contacts.update', 'contacts.log_contact']) {
      expect(tools[name]).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    }
    const out = { name: 'Mara Voss' } as ContactDto
    expect(tools['contacts.create'].activity!({ name: 'Mara Voss' }, out)).toBe('Added a contact')
    expect(tools['contacts.update'].activity!({ id: 'x' }, out)).toBe('Updated a contact')
    expect(tools['contacts.log_contact'].activity!({ id: 'x' }, out)).toBe('Logged being in touch with a contact')
  })

  it('a person sees their own and shared contacts', async () => {
    const { tools, anasPrivate } = await setup()
    const out = (await tools['contacts.list'].handler(humanCtx('ana'), {})) as { contacts: ContactDto[] }
    expect(out.contacts.map((c) => c.id)).toEqual([anasPrivate.id])
  })

  it('the brain acting as a person sees exactly what that person sees (CB3)', async () => {
    const { tools, bensPrivate, anasPrivate } = await setup()
    const asBen = brainFor('ben')
    const out = (await tools['contacts.list'].handler(asBen, {})) as { contacts: ContactDto[] }
    expect(out.contacts.map((c) => c.id)).toEqual([bensPrivate.id])
    await expect(tools['contacts.get'].handler(asBen, { id: anasPrivate.id })).rejects.toMatchObject({ code: 'not_found' })
    // What it adds is that person's own private contact.
    const made = (await tools['contacts.create'].handler(asBen, { name: 'Lee' })) as ContactDto
    expect(made).toMatchObject({ own: true, shared: false, createdByName: 'Ben Ode' })
  })

  it('an agent key that belongs to a person is that person', async () => {
    const { tools, bensPrivate } = await setup({ agentPerson: 'ben' })
    const out = (await tools['contacts.list'].handler(agentCtx, {})) as { contacts: ContactDto[] }
    expect(out.contacts.map((c) => c.id)).toEqual([bensPrivate.id])
  })

  it('the agent on its own acts with admin rights, like Drive', async () => {
    const { tools } = await setup()
    const out = (await tools['contacts.list'].handler(agentCtx, {})) as { contacts: ContactDto[] }
    expect(out.contacts.map((c) => c.name)).toEqual(['Jon Park', 'Mara Voss'])
  })

  it('lists by tag and search, reads one, updates and logs a contact', async () => {
    const { f, tools, anasPrivate } = await setup()
    const ctx = humanCtx('ana')
    const byTag = (await tools['contacts.list'].handler(ctx, { tag: 'investor', query: 'mara' })) as { contacts: ContactDto[] }
    expect(byTag.contacts.map((c) => c.id)).toEqual([anasPrivate.id])
    await tools['contacts.update'].handler(ctx, { id: anasPrivate.id, organisation: 'Northwind', channels: [{ type: 'phone', value: '+49 30 1234' }] })
    const logged = (await tools['contacts.log_contact'].handler(ctx, {
      id: anasPrivate.id,
      how_it_went: 'Good call',
      next_follow_up_on: '2026-12-01',
      next_step: 'Send the deck',
    })) as ContactDto
    expect(logged).toMatchObject({
      organisation: 'Northwind',
      channels: [{ type: 'phone', value: '+49 30 1234' }],
      lastContactedOn: '2026-11-12',
      nextFollowUpOn: '2026-12-01',
      nextStep: 'Send the deck',
    })
    expect(await tools['contacts.get'].handler(ctx, { id: anasPrivate.id })).toMatchObject({ lastContactedOn: '2026-11-12' })
    // Kept in the contact's history, with the follow-up it answered.
    expect(f.store.log).toEqual([
      expect.objectContaining({ on: '2026-11-12', note: 'Good call', answeredFollowUpOn: '2026-11-13', nextFollowUpOn: '2026-12-01' }),
    ])
  })

  it('follow_ups answers "who should I write to next" for today (or a given day)', async () => {
    const { tools, anasPrivate } = await setup()
    const out = (await tools['contacts.follow_ups'].handler(humanCtx('ana'), {})) as { today: string; followUps: FollowUpDto[] }
    expect(out.today).toBe('2026-11-12')
    expect(out.followUps.map((c) => [c.id, c.due])).toEqual([[anasPrivate.id, 'upcoming']])
    const later = (await tools['contacts.follow_ups'].handler(humanCtx('ana'), { today: '2026-11-20' })) as { followUps: FollowUpDto[] }
    expect(later.followUps.map((c) => c.due)).toEqual(['overdue'])
  })

  it('works the pipeline: reads the lists and the review, moves a contact, sets who holds it and how we are in touch', async () => {
    const { tools, anasPrivate } = await setup()
    const ctx = humanCtx('ana')
    const before = (await tools['contacts.pipeline'].handler(ctx, {})) as Pipeline
    expect(before.today).toBe('2026-11-12')
    expect(before.groups.map((g) => [g.stage, g.items.map((i) => i.id)])).toEqual([
      ['next', []],
      ['waiting', []],
      ['keep_in_touch', []],
      ['inbox', [anasPrivate.id]],
    ])
    expect(before.people.map((p) => p.id)).toContain('ben')
    const moved = (await tools['contacts.update'].handler(ctx, {
      id: anasPrivate.id,
      stage: 'waiting',
      owner_id: 'ben',
      via: 'email',
      latest_status: 'Sent the deck',
    })) as ContactDto
    // The wait starts today (the tools' day).
    expect(moved).toMatchObject({ stage: 'waiting', waitingSince: '2026-11-12', ownerId: 'ben', via: 'email', latestStatus: 'Sent the deck' })
    const waiting = (await tools['contacts.pipeline'].handler(ctx, { stage: 'waiting', today: '2026-11-25' })) as Pipeline
    expect(waiting.groups).toHaveLength(1)
    expect(waiting.groups[0]!.items[0]!.review).toMatchObject({ daysWaiting: 13, staleWaiting: true })
    const logged = (await tools['contacts.log_contact'].handler(ctx, { id: anasPrivate.id, stage: 'next', next_step: 'Book a call' })) as ContactDto
    expect(logged).toMatchObject({ stage: 'next', waitingSince: null, nextStep: 'Book a call' })
    await expect(tools['contacts.update'].handler(ctx, { id: anasPrivate.id, stage: 'won' })).rejects.toThrow()
  })

  it('rejects unknown keys: sharing is a person’s decision, not the agent’s', async () => {
    const { tools, anasPrivate } = await setup()
    await expect(tools['contacts.create'].handler(agentCtx, { name: 'Lee', shared: true })).rejects.toThrow()
    await expect(tools['contacts.update'].handler(agentCtx, { id: anasPrivate.id, shared: true })).rejects.toThrow()
  })
})
