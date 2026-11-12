import { describe, expect, it } from 'vitest'
import {
  contactTags,
  createContact,
  deleteContact,
  followUps,
  getContact,
  listContacts,
  logContact,
  setShared,
  updateContact,
} from './service'
import { agent, fixture, user } from './test-fixtures'
import { dayIn, DEFAULT_TAGS, relativeDays, visibilityText } from './types'

const ana = user('ana')
const ben = user('ben')
const olga = user('olga')
const adam = user('adam')

describe('creating a contact', () => {
  it('stores a person with channels, where you met, why they matter and tags — private by default', async () => {
    const { deps, events } = fixture()
    const c = await createContact(deps, ana, {
      name: '  Mara Voss ',
      organisation: 'Northwind Capital',
      title: 'Partner',
      channels: [
        { type: 'linkedin', value: ' https://www.linkedin.com/in/maravoss ' },
        { type: 'email', value: 'mara@northwind.example' },
      ],
      metHow: 'Founders breakfast in Berlin',
      whyRelevant: 'Leads seed rounds in B2B software',
      tags: ['Investor', 'investor', '  Seed   round '],
      nextFollowUpOn: '2026-11-20',
      nextStep: 'Send the deck',
    })
    expect(c).toMatchObject({
      name: 'Mara Voss',
      organisation: 'Northwind Capital',
      title: 'Partner',
      channels: [
        { type: 'linkedin', value: 'https://www.linkedin.com/in/maravoss' },
        { type: 'email', value: 'mara@northwind.example' },
      ],
      metHow: 'Founders breakfast in Berlin',
      whyRelevant: 'Leads seed rounds in B2B software',
      tags: ['investor', 'seed round'],
      lastContactedOn: null,
      nextFollowUpOn: '2026-11-20',
      nextStep: 'Send the deck',
      shared: false,
      own: true,
      createdByName: 'Ana Lind',
      canManage: true,
    })
    // The audit trail names the contact by id only: its details are private.
    expect(events).toEqual([{ type: 'contacts.created', principalId: 'ana', payload: { id: c.id, shared: false } }])
  })

  it('can be shared with the company from the start', async () => {
    const { deps } = fixture()
    const c = await createContact(deps, ana, { name: 'Lee' }, { shared: true })
    expect(c.shared).toBe(true)
    expect((await getContact(deps, ben, c.id)).name).toBe('Lee')
  })

  it.each([
    [{ name: '   ' }, /name/],
    [{ name: 'x'.repeat(201) }, /name/],
    [{ name: 'A', channels: [{ type: 'fax', value: '1' }] }, /channel type/],
    [{ name: 'A', channels: [{ type: 'email', value: '  ' }] }, /channel/],
    [{ name: 'A', channels: 'mara@x' }, /channels/],
    [{ name: 'A', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, /20 tags/],
    [{ name: 'A', tags: ['x'.repeat(41)] }, /tag/],
    [{ name: 'A', nextFollowUpOn: '2026-02-30' }, /date/],
    [{ name: 'A', lastContactedOn: '12.11.2026' }, /date/],
    [{ name: 'A', nextStep: 'x'.repeat(501) }, /next step/],
  ])('refuses %j', async (input, message) => {
    const { deps } = fixture()
    await expect(createContact(deps, ana, input)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(message) })
  })

  it('refuses someone who is not in the company', async () => {
    const { deps } = fixture()
    await expect(createContact(deps, user('ghost'), { name: 'A' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('who can see a contact', () => {
  it('a private contact: its creator, the owner and admins (and the agent) — nobody else', async () => {
    const { deps } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara Voss' })
    expect((await listContacts(deps, ben)).contacts).toEqual([])
    await expect(getContact(deps, ben, c.id)).rejects.toMatchObject({ code: 'not_found' })
    for (const admin of [olga, adam]) {
      expect(await getContact(deps, admin, c.id)).toMatchObject({ own: false, createdByName: 'Ana Lind', canManage: true })
      expect((await listContacts(deps, admin)).contacts.map((x) => x.id)).toEqual([c.id])
    }
    expect(await getContact(deps, agent, c.id)).toMatchObject({ own: false, canManage: false })
  })

  it('a shared contact: everyone in the company sees and updates it; only its creator, the owner and admins unshare or delete it', async () => {
    const { deps, events } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara Voss' })
    await setShared(deps, ana, c.id, true)
    expect(events.at(-1)).toEqual({ type: 'contacts.sharing_changed', principalId: 'ana', payload: { id: c.id, shared: true } })
    expect(await getContact(deps, ben, c.id)).toMatchObject({ shared: true, own: false, canManage: false })
    await updateContact(deps, ben, c.id, { title: 'Partner' })
    await logContact(deps, ben, c.id, { on: '2026-11-12' })
    await expect(setShared(deps, ben, c.id, false)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(deleteContact(deps, ben, c.id)).rejects.toMatchObject({ code: 'forbidden' })
    await setShared(deps, adam, c.id, false)
    await expect(getContact(deps, ben, c.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('the agent never shares or deletes', async () => {
    const { deps } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara Voss' })
    await expect(setShared(deps, agent, c.id, true)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(deleteContact(deps, agent, c.id)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('a contact the agent added on its own is private to the owner and admins', async () => {
    const { deps } = fixture()
    const c = await createContact(deps, agent, { name: 'Mara Voss' })
    expect(c.createdByName).toBe('the agent')
    await expect(getContact(deps, ana, c.id)).rejects.toMatchObject({ code: 'not_found' })
    expect(await getContact(deps, olga, c.id)).toMatchObject({ createdByName: 'the agent', canManage: true })
  })

  it('says it plainly', () => {
    expect(visibilityText({ shared: false, own: true, createdByName: 'Ana Lind' })).toBe(
      'Private: only you, the company owner and admins can see it.',
    )
    expect(visibilityText({ shared: false, own: false, createdByName: 'Ana Lind' })).toBe(
      'Private to Ana Lind: only they, the company owner and admins can see it.',
    )
    expect(visibilityText({ shared: true, own: false, createdByName: 'Ana Lind' })).toBe(
      'Shared with the company: everyone in the company can see and update it.',
    )
  })
})

describe('the list', () => {
  async function seeded() {
    const f = fixture()
    const mara = await createContact(f.deps, ana, { name: 'Mara Voss', organisation: 'Northwind Capital', tags: ['investor'] })
    const jon = await createContact(f.deps, ana, { name: 'jon Park', organisation: 'Atelier Print', tags: ['production', 'Printing'] })
    const zoe = await createContact(f.deps, ana, { name: 'Zoë 100% Real', tags: ['customer'] })
    return { ...f, mara, jon, zoe }
  }

  it('is ordered by name and offers the default tags first, then the ones people added', async () => {
    const { deps, mara, jon, zoe } = await seeded()
    const out = await listContacts(deps, ana)
    expect(out.contacts.map((c) => c.id)).toEqual([jon.id, mara.id, zoe.id])
    expect(out.tags).toEqual([...DEFAULT_TAGS, 'printing'])
  })

  it('filters by one tag and searches name and organisation (case-insensitive, literal)', async () => {
    const { deps, mara, jon, zoe } = await seeded()
    expect((await listContacts(deps, ana, { tag: 'Investor' })).contacts.map((c) => c.id)).toEqual([mara.id])
    expect((await listContacts(deps, ana, { query: 'NORTH' })).contacts.map((c) => c.id)).toEqual([mara.id])
    expect((await listContacts(deps, ana, { query: 'park' })).contacts.map((c) => c.id)).toEqual([jon.id])
    expect((await listContacts(deps, ana, { query: '100%' })).contacts.map((c) => c.id)).toEqual([zoe.id])
    expect((await listContacts(deps, ana, { query: '%' })).contacts.map((c) => c.id)).toEqual([zoe.id])
    expect((await listContacts(deps, ana, { tag: 'production', query: 'atelier' })).contacts.map((c) => c.id)).toEqual([jon.id])
    expect((await listContacts(deps, ana, { tag: '', query: '  ' })).contacts).toHaveLength(3)
  })

  it('offers only the tags of contacts the viewer can see', async () => {
    const { deps } = await seeded()
    expect((await listContacts(deps, ben)).tags).toEqual([...DEFAULT_TAGS])
    expect(await contactTags(deps, ben)).toEqual([...DEFAULT_TAGS])
    expect(await contactTags(deps, ana)).toEqual([...DEFAULT_TAGS, 'printing'])
  })
})

describe('updating', () => {
  it('changes only what is sent; empty text clears a field', async () => {
    const { deps, events } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara', organisation: 'Northwind', title: 'Partner' })
    const out = await updateContact(deps, ana, c.id, { organisation: '', title: null, tags: ['funder'] })
    expect(out).toMatchObject({ name: 'Mara', organisation: null, title: null, tags: ['funder'] })
    expect(events.at(-1)).toEqual({
      type: 'contacts.updated',
      principalId: 'ana',
      payload: { id: c.id, fields: ['organisation', 'title', 'tags'] },
    })
  })

  it('refuses an empty name, an empty change and an unknown id', async () => {
    const { deps } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara' })
    await expect(updateContact(deps, ana, c.id, { name: '' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(updateContact(deps, ana, c.id, {})).rejects.toMatchObject({ code: 'invalid' })
    await expect(updateContact(deps, ana, 'nope', { name: 'X' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(updateContact(deps, ana, '00000000-0000-4000-8000-000000000999', { name: 'X' })).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('logging a contact', () => {
  it('sets the day you were in touch and replaces the follow-up (none when left empty)', async () => {
    const { deps, events } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara', nextFollowUpOn: '2026-11-13', nextStep: 'Call' })
    const logged = await logContact(deps, ana, c.id, { on: '2026-11-12', nextFollowUpOn: '2026-12-01', nextStep: 'Send the deck' })
    expect(logged).toMatchObject({ lastContactedOn: '2026-11-12', nextFollowUpOn: '2026-12-01', nextStep: 'Send the deck' })
    expect(events.at(-1)).toEqual({ type: 'contacts.contact_logged', principalId: 'ana', payload: { id: c.id } })
    const again = await logContact(deps, ana, c.id, { on: '2026-12-01' })
    expect(again).toMatchObject({ lastContactedOn: '2026-12-01', nextFollowUpOn: null, nextStep: null })
  })

  it('refuses a follow-up before the day you were in touch, and a missing day', async () => {
    const { deps } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara' })
    await expect(logContact(deps, ana, c.id, { on: '2026-11-12', nextFollowUpOn: '2026-11-11' })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(logContact(deps, ana, c.id, { on: '' })).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('follow up next (who to write to next)', () => {
  async function seeded() {
    const f = fixture()
    const make = (actor: ReturnType<typeof user>, name: string, nextFollowUpOn: string | null, shared = false) =>
      createContact(f.deps, actor, { name, nextFollowUpOn }, { shared })
    const late = await make(ana, 'Late', '2026-11-01')
    const today = await make(ana, 'Today B', '2026-11-12')
    const todayA = await make(ana, 'today A', '2026-11-12')
    const soon = await make(ana, 'Soon', '2026-11-26')
    await make(ana, 'Later', '2026-11-27')
    await make(ana, 'Never', null)
    const bensShared = await make(ben, 'Bens shared', '2026-11-15', true)
    const bensPrivate = await make(ben, 'Bens private', '2026-11-14')
    return { ...f, late, today, todayA, soon, bensShared, bensPrivate }
  }

  it('lists what is due and what comes up in the next 14 days, soonest first', async () => {
    const { deps, late, today, todayA, soon, bensShared } = await seeded()
    const out = await followUps(deps, ana, '2026-11-12')
    expect(out.map((c) => [c.id, c.due, c.daysFromToday])).toEqual([
      [late.id, 'overdue', -11],
      [todayA.id, 'today', 0],
      [today.id, 'today', 0],
      [bensShared.id, 'upcoming', 3],
      [soon.id, 'upcoming', 14],
    ])
  })

  it("is personal: the owner and admins don't get other people's private follow-ups; the agent on its own gets all", async () => {
    const { deps, bensShared, bensPrivate } = await seeded()
    expect((await followUps(deps, olga, '2026-11-12')).map((c) => c.id)).toEqual([bensShared.id])
    expect((await followUps(deps, ben, '2026-11-12')).map((c) => c.id)).toContain(bensPrivate.id)
    expect((await followUps(deps, agent, '2026-11-12')).map((c) => c.id)).toContain(bensPrivate.id)
  })

  it('today is the day where the person lives; days read as words', () => {
    expect(dayIn('Europe/Berlin', new Date('2026-11-12T23:30:00Z'))).toBe('2026-11-13')
    expect(dayIn('UTC', new Date('2026-11-12T23:30:00Z'))).toBe('2026-11-12')
    expect([-3, -1, 0, 1, 5].map(relativeDays)).toEqual(['3 days ago', 'yesterday', 'today', 'tomorrow', 'in 5 days'])
  })

  it('needs a real day', async () => {
    const { deps } = fixture()
    await expect(followUps(deps, ana, 'tomorrow')).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('deleting', () => {
  it('its creator deletes it; someone who cannot see it gets not found', async () => {
    const { deps, events } = fixture()
    const c = await createContact(deps, ana, { name: 'Mara' })
    await expect(deleteContact(deps, ben, c.id)).rejects.toMatchObject({ code: 'not_found' })
    await deleteContact(deps, ana, c.id)
    expect(events.at(-1)).toEqual({ type: 'contacts.deleted', principalId: 'ana', payload: { id: c.id } })
    await expect(getContact(deps, ana, c.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})
