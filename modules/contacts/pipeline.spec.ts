import { describe, expect, it } from 'vitest'
import { createContact, getContact, importContacts, logContact, pipeline, updateContact } from './service'
import { agent, fixture, user } from './test-fixtures'

/** The pipeline (Contribute 8c6a0cb7): Ony's four groups as GTD lists, set explicitly, reviewed weekly. */

describe('contacts pipeline: the fields', () => {
  it('a new contact starts in the inbox, held by the person who added it; the agent’s is held by nobody', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    expect(mara).toMatchObject({ stage: 'inbox', ownerId: 'ana', ownerName: 'Ana Lind', via: null, latestStatus: null, waitingSince: null })
    const lee = await createContact(f.deps, agent, { name: 'Lee' })
    expect(lee).toMatchObject({ stage: 'inbox', ownerId: null, ownerName: null })
  })

  it('stage, owner, via, latest status and next step are set explicitly and come back', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    const out = await updateContact(f.deps, user('ana'), mara.id, {
      stage: 'next',
      ownerId: 'ben',
      via: 'linkedin',
      latestStatus: 'Liked the deck',
      nextStep: 'Send the pricing',
    })
    expect(out).toMatchObject({ stage: 'next', ownerId: 'ben', ownerName: 'Ben Ode', via: 'linkedin', latestStatus: 'Liked the deck', nextStep: 'Send the pricing' })
    expect(f.events.at(-1)).toMatchObject({ type: 'contacts.updated', payload: { id: mara.id, fields: ['nextStep', 'stage', 'ownerId', 'via', 'latestStatus'] } })
  })

  it('refuses an unknown stage or via, and an owner who is not in the company', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(updateContact(f.deps, user('ana'), mara.id, { stage: 'done' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(updateContact(f.deps, user('ana'), mara.id, { via: 'pigeon' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(updateContact(f.deps, user('ana'), mara.id, { ownerId: 'stranger' })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('not in the company'),
    })
    // Clearing the owner is fine.
    expect(await updateContact(f.deps, user('ana'), mara.id, { ownerId: null })).toMatchObject({ ownerId: null, ownerName: null })
  })

  it('moving to "waiting" starts the wait today (or on the day you say); leaving it ends the wait', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    expect(await updateContact(f.deps, user('ana'), mara.id, { stage: 'waiting' }, { today: '2026-11-12' })).toMatchObject({
      stage: 'waiting',
      waitingSince: '2026-11-12',
    })
    // Still waiting: another change keeps the day the wait began.
    expect(await updateContact(f.deps, user('ana'), mara.id, { nextStep: 'Chase' }, { today: '2026-11-15' })).toMatchObject({ waitingSince: '2026-11-12' })
    expect(await updateContact(f.deps, user('ana'), mara.id, { waitingSince: '2026-11-01' })).toMatchObject({ waitingSince: '2026-11-01' })
    expect(await updateContact(f.deps, user('ana'), mara.id, { stage: 'next' })).toMatchObject({ stage: 'next', waitingSince: null })
  })

  it('a waiting-since day without waiting, or waiting without knowing since when, is refused', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(updateContact(f.deps, user('ana'), mara.id, { waitingSince: '2026-11-01' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(updateContact(f.deps, user('ana'), mara.id, { stage: 'waiting' })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('since when'),
    })
  })

  it('"Log a contact" moves it only when told: "waiting for a reply" starts the wait on the day you were in touch', async () => {
    const f = fixture()
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    const same = await logContact(f.deps, user('ana'), mara.id, { on: '2026-11-10', note: 'Wrote her' })
    expect(same).toMatchObject({ stage: 'inbox', waitingSince: null })
    const waiting = await logContact(f.deps, user('ana'), mara.id, {
      on: '2026-11-11',
      stage: 'waiting',
      via: 'email',
      latestStatus: 'Sent the deck',
    })
    expect(waiting).toMatchObject({ stage: 'waiting', waitingSince: '2026-11-11', via: 'email', latestStatus: 'Sent the deck', lastContactedOn: '2026-11-11' })
    const back = await logContact(f.deps, user('ana'), mara.id, { on: '2026-11-12', stage: 'next', nextStep: 'Book a call' })
    expect(back).toMatchObject({ stage: 'next', waitingSince: null, nextStep: 'Book a call', latestStatus: 'Sent the deck' })
  })

  it('imported contacts start in the inbox, held by the importer', async () => {
    const f = fixture()
    const { created } = await importContacts(f.deps, user('ana'), [{ name: 'Jon Park', channels: [], tags: [] }], { shared: false })
    expect(await getContact(f.deps, user('ana'), created[0]!.id)).toMatchObject({ stage: 'inbox', ownerId: 'ana' })
  })
})

describe('contacts pipeline: the overview and the weekly review', () => {
  async function seeded() {
    const f = fixture()
    const ana = user('ana')
    const today = '2026-11-20'
    const next = await createContact(f.deps, ana, { name: 'Nina Next', nextStep: 'Send the offer', nextFollowUpOn: '2026-11-18' })
    await updateContact(f.deps, ana, next.id, { stage: 'next' })
    const bare = await createContact(f.deps, ana, { name: 'Bo Bare' })
    await updateContact(f.deps, ana, bare.id, { stage: 'next' })
    const old = await createContact(f.deps, ana, { name: 'Olli Old' })
    await updateContact(f.deps, ana, old.id, { stage: 'waiting', waitingSince: '2026-11-05' }, { today })
    const fresh = await createContact(f.deps, ana, { name: 'Fia Fresh' })
    await updateContact(f.deps, ana, fresh.id, { stage: 'waiting' }, { today: '2026-11-18' })
    const loop = await createContact(f.deps, ana, { name: 'Lu Loop', nextFollowUpOn: '2026-11-19' })
    await updateContact(f.deps, ana, loop.id, { stage: 'keep_in_touch' })
    const later = await createContact(f.deps, ana, { name: 'Lea Later', nextFollowUpOn: '2026-12-20' })
    await updateContact(f.deps, ana, later.id, { stage: 'keep_in_touch' })
    const inbox = await createContact(f.deps, ana, { name: 'Ida Inbox' })
    const bens = await createContact(f.deps, user('ben'), { name: 'Bens private' })
    return { f, today, next, bare, old, fresh, loop, later, inbox, bens }
  }

  it('groups what the viewer sees in Ony’s order, oldest wait first, soonest day first', async () => {
    const s = await seeded()
    const out = await pipeline(s.f.deps, user('ana'), s.today)
    expect(out.today).toBe('2026-11-20')
    expect(out.groups.map((g) => [g.stage, g.items.map((i) => i.name)])).toEqual([
      ['next', ['Nina Next', 'Bo Bare']],
      ['waiting', ['Olli Old', 'Fia Fresh']],
      ['keep_in_touch', ['Lu Loop', 'Lea Later']],
      ['inbox', ['Ida Inbox']],
    ])
    expect(out.people.map((p) => p.name)).toEqual(['Adam Admin', 'Ana Lind', 'Ben Ode', 'Olga Owner'])
  })

  it('flags what the weekly review should look at', async () => {
    const s = await seeded()
    const out = await pipeline(s.f.deps, user('ana'), s.today)
    const item = (name: string) => out.groups.flatMap((g) => g.items).find((i) => i.name === name)!.review
    expect(item('Nina Next')).toMatchObject({ overdue: true, daysFromToday: -2, missingNextStep: false, needsReview: true })
    expect(item('Bo Bare')).toMatchObject({ overdue: false, daysFromToday: null, missingNextStep: true, needsReview: true })
    expect(item('Olli Old')).toMatchObject({ daysWaiting: 15, staleWaiting: true, needsReview: true })
    expect(item('Fia Fresh')).toMatchObject({ daysWaiting: 2, staleWaiting: false, needsReview: false })
    expect(item('Lu Loop')).toMatchObject({ overdue: true, needsReview: true })
    expect(item('Lea Later')).toMatchObject({ overdue: false, daysFromToday: 30, needsReview: false })
    expect(item('Ida Inbox')).toMatchObject({ needsReview: true })
    expect(out.review).toEqual({ waitingTooLong: 1, overdue: 2, nextWithoutStep: 1, inbox: 1, waitingDays: 7 })
  })

  it('the owner sees every contact (like the list); a bad day is refused', async () => {
    const s = await seeded()
    const out = await pipeline(s.f.deps, user('olga'), s.today)
    expect(out.groups.find((g) => g.stage === 'inbox')!.items.map((i) => i.name)).toEqual(['Bens private', 'Ida Inbox'])
    await expect(pipeline(s.f.deps, user('ana'), 'soon')).rejects.toMatchObject({ code: 'invalid' })
  })
})
