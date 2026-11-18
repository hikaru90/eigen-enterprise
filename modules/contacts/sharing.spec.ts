import type { ContactDto } from './types'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import {
  createContact,
  getContact,
  importContacts,
  listContacts,
  makeContactsPrivate,
  setCompanyDefaultVisibility,
  setMyDefaultVisibility,
  setShared,
  shareChoices,
  shareContacts,
  visibilityDefaults,
} from './service'
import { agent, fixture, user } from './test-fixtures'
import { createContactsTools } from './tools'
import { visibilityLabel, visibilityText } from './types'

/**
 * Sharing many contacts at once, the whole team, people and groups, and the
 * default for new contacts (migration 0150, Contribute 9d28020a).
 */

const ana = user('ana')
const ben = user('ben')
const olga = user('olga')
const adam = user('adam')

const names = async (f: ReturnType<typeof fixture>, who: ReturnType<typeof user>) =>
  (await listContacts(f.deps, who)).contacts.map((c) => c.name)

describe('Share with… for many contacts', () => {
  it('shares every chosen contact of yours with the whole team in one call — a member who joins later sees them too', async () => {
    const f = fixture()
    const a = await createContact(f.deps, ana, { name: 'A' })
    const b = await createContact(f.deps, ana, { name: 'B' })
    const out = await shareContacts(f.deps, ana, [a.id, b.id], { team: true })
    expect(out).toEqual({ changed: [a.id, b.id], skipped: [] })
    expect(await names(f, ben)).toEqual(['A', 'B'])

    f.join('cleo', 'Cleo New') // joins after the share
    expect(await names(f, user('cleo'))).toEqual(['A', 'B'])
    expect(await getContact(f.deps, user('cleo'), a.id)).toMatchObject({
      shared: true,
      own: false,
      canManage: false,
    })
    expect(f.events.at(-1)).toEqual({
      type: 'contacts.sharing_changed',
      principalId: 'ana',
      payload: { ids: [a.id, b.id], team: true, userIds: [], groupIds: [] },
    })
  })

  it('skips the ones that are not yours (by name) and the ones you can’t see (no name), changing the rest', async () => {
    const f = fixture()
    const mine = await createContact(f.deps, ana, { name: 'Mine' })
    const bensShared = await createContact(f.deps, ben, { name: 'Bens shared' }, { shared: true })
    const bensPrivate = await createContact(f.deps, ben, { name: 'Bens private' })
    const out = await shareContacts(f.deps, ana, [mine.id, bensShared.id, bensPrivate.id], {
      userIds: ['olga'],
    })
    expect(out).toEqual({
      changed: [mine.id],
      skipped: [
        { id: bensShared.id, name: 'Bens shared', reason: 'not_yours' },
        { id: bensPrivate.id, name: null, reason: 'not_found' },
      ],
    })
    // Nothing changed on Ben's contacts.
    expect((await getContact(f.deps, ben, bensShared.id)).sharedWith).toEqual([])
  })

  it('the owner and admins may change anyone’s contacts', async () => {
    const f = fixture()
    const bens = await createContact(f.deps, ben, { name: 'Bens private' })
    expect(await shareContacts(f.deps, adam, [bens.id], { team: true })).toEqual({
      changed: [bens.id],
      skipped: [],
    })
    expect(await names(f, ana)).toEqual(['Bens private'])
  })

  it('a person share is that person; a group share follows the group as it is when read', async () => {
    const f = fixture()
    f.store.groups.set('sales', { name: 'Sales', members: new Set(['ben']) })
    const forOlga = await createContact(f.deps, ana, { name: 'For Ben' })
    const forSales = await createContact(f.deps, ana, { name: 'For Sales' })
    await shareContacts(f.deps, ana, [forOlga.id], { userIds: ['ben'] })
    await shareContacts(f.deps, ana, [forSales.id], { groupIds: ['sales'] })
    f.join('cleo', 'Cleo New')
    expect(await names(f, ben)).toEqual(['For Ben', 'For Sales'])
    expect(await names(f, user('cleo'))).toEqual([])
    f.store.groups.get('sales')!.members.add('cleo')
    expect(await names(f, user('cleo'))).toEqual(['For Sales'])

    const seen = await getContact(f.deps, user('cleo'), forSales.id)
    expect(seen).toMatchObject({
      shared: false,
      sharedWithViewer: true,
      own: false,
      canManage: false,
    })
    expect(seen.sharedWith).toEqual([{ kind: 'group', id: 'sales', name: 'Sales' }])
    expect(visibilityLabel(seen)).toBe('Shared with Sales')
    expect(visibilityText(seen)).toBe('Shared with Sales: they, Ana Lind, the company owner and admins can see and update it.')
    // Shares add up: sharing again keeps what was there.
    await shareContacts(f.deps, ana, [forSales.id], { userIds: ['olga'] })
    expect((await getContact(f.deps, ana, forSales.id)).sharedWith.map((s) => s.name)).toEqual(['Sales', 'Olga Owner'])
  })

  it('refuses unknown members or groups, no target, no contacts — and the agent', async () => {
    const f = fixture()
    const a = await createContact(f.deps, ana, { name: 'A' })
    await expect(shareContacts(f.deps, ana, [a.id], { userIds: ['nobody'] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(shareContacts(f.deps, ana, [a.id], { groupIds: ['nogroup'] })).rejects.toMatchObject({ code: 'invalid' })
    await expect(shareContacts(f.deps, ana, [a.id], {})).rejects.toMatchObject({ code: 'invalid' })
    await expect(shareContacts(f.deps, ana, [], { team: true })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(shareContacts(f.deps, ana, 'x', { team: true })).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(shareContacts(f.deps, agent, [a.id], { team: true })).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(f.store.shareRows).toEqual([])
  })

  it('offers the company’s people and groups by name', async () => {
    const f = fixture()
    f.store.groups.set('sales', { name: 'Sales', members: new Set() })
    expect(await shareChoices(f.deps, ana)).toEqual({
      people: [
        { id: 'adam', name: 'Adam Admin' },
        { id: 'ana', name: 'Ana Lind' },
        { id: 'ben', name: 'Ben Ode' },
        { id: 'olga', name: 'Olga Owner' },
      ],
      groups: [{ id: 'sales', name: 'Sales' }],
    })
  })
})

describe('Make private for many contacts', () => {
  it('ends the whole-team share and every person and group share of the ones that are yours', async () => {
    const f = fixture()
    f.store.groups.set('sales', { name: 'Sales', members: new Set(['ben']) })
    const a = await createContact(f.deps, ana, { name: 'A' })
    const b = await createContact(f.deps, ana, { name: 'B' })
    const bens = await createContact(f.deps, ben, { name: 'Bens shared' }, { shared: true })
    await shareContacts(f.deps, ana, [a.id, b.id], {
      team: true,
      userIds: ['olga'],
      groupIds: ['sales'],
    })
    const out = await makeContactsPrivate(f.deps, ana, [a.id, b.id, bens.id])
    expect(out).toEqual({
      changed: [a.id, b.id],
      skipped: [{ id: bens.id, name: 'Bens shared', reason: 'not_yours' }],
    })
    expect(await names(f, ben)).toEqual(['Bens shared'])
    expect(f.store.shareRows).toEqual([])
    expect(f.events.at(-1)).toMatchObject({
      type: 'contacts.sharing_changed',
      payload: { ids: [a.id, b.id], shared: false },
    })
  })

  it('one contact’s "Make private" also ends its people and group shares; existing whole-team shares keep working', async () => {
    const f = fixture()
    const a = await createContact(f.deps, ana, { name: 'A' }, { shared: true })
    expect(await names(f, ben)).toEqual(['A'])
    await shareContacts(f.deps, ana, [a.id], { userIds: ['ben'] })
    await setShared(f.deps, ana, a.id, false)
    expect(await names(f, ben)).toEqual([])
    expect(f.store.shareRows).toEqual([])
  })
})

describe('the default for new contacts', () => {
  it('precedence: your own choice, else the company default, else private', async () => {
    const f = fixture()
    expect(await visibilityDefaults(f.deps, ana)).toEqual({
      person: null,
      company: null,
      effective: 'private',
    })
    expect((await createContact(f.deps, ana, { name: 'P1' })).shared).toBe(false)

    await setCompanyDefaultVisibility(f.deps, olga, 'team')
    expect(await visibilityDefaults(f.deps, ana)).toEqual({
      person: null,
      company: 'team',
      effective: 'team',
    })
    expect((await createContact(f.deps, ana, { name: 'T1' })).shared).toBe(true)

    await setMyDefaultVisibility(f.deps, ana, 'private')
    expect(await visibilityDefaults(f.deps, ana)).toEqual({
      person: 'private',
      company: 'team',
      effective: 'private',
    })
    expect((await createContact(f.deps, ana, { name: 'P2' })).shared).toBe(false)
    // Ben has no own choice: the company's.
    expect((await createContact(f.deps, ben, { name: 'T2' })).shared).toBe(true)

    await setMyDefaultVisibility(f.deps, ana, '')
    expect((await visibilityDefaults(f.deps, ana)).effective).toBe('team')
    await setCompanyDefaultVisibility(f.deps, adam, 'private')
    await setMyDefaultVisibility(f.deps, ben, 'team')
    expect((await visibilityDefaults(f.deps, ben)).effective).toBe('team')
    expect((await visibilityDefaults(f.deps, ana)).effective).toBe('private')
    expect(f.events.filter((e) => e.type === 'contacts.default_visibility_set').at(-1)).toEqual({
      type: 'contacts.default_visibility_set',
      principalId: 'ben',
      payload: { scope: 'person', visibility: 'team' },
    })
  })

  it('a choice on the form wins over the default (both ways)', async () => {
    const f = fixture()
    await setMyDefaultVisibility(f.deps, ana, 'team')
    expect((await createContact(f.deps, ana, { name: 'Kept private' }, { shared: false })).shared).toBe(false)
    await setMyDefaultVisibility(f.deps, ana, 'private')
    expect((await createContact(f.deps, ana, { name: 'Shared now' }, { shared: true })).shared).toBe(true)
  })

  it('only the owner and admins set the company default; nobody sets an unknown one', async () => {
    const f = fixture()
    await expect(setCompanyDefaultVisibility(f.deps, ana, 'team')).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(setCompanyDefaultVisibility(f.deps, agent, 'team')).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(setMyDefaultVisibility(f.deps, ana, 'everyone')).rejects.toMatchObject({
      code: 'invalid',
    })
    await expect(setMyDefaultVisibility(f.deps, agent, 'team')).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(f.store.companyDefault.value).toBeNull()
  })

  it('applies to imports (unless the importer chooses) and to the agent’s tools', async () => {
    const f = fixture()
    await setMyDefaultVisibility(f.deps, ana, 'team')
    const imported = await importContacts(f.deps, ana, [{ name: 'Jon Park' }])
    expect(imported.created.map((c) => c.shared)).toEqual([true])
    const chosen = await importContacts(f.deps, ana, [{ name: 'Kai Private' }], { shared: false })
    expect(chosen.created.map((c) => c.shared)).toEqual([false])

    let behalf: string | null = 'ana'
    const tools = Object.fromEntries(
      createContactsTools({
        deps: async () => f.deps,
        onBehalfOf: async () => behalf,
        today: () => '2026-11-12',
      }).map((t) => [t.name, t]),
    )
    const agentCtx: ToolContext = {
      principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
      requestId: 'r1',
    }
    // Working for Ana: her default.
    const forAna = (await tools['contacts.create']!.handler(agentCtx, {
      name: 'Via the agent',
    })) as ContactDto
    expect(forAna).toMatchObject({ shared: true, own: true })
    // On its own: the company default (private until the owner or an admin sets it).
    behalf = null
    expect(((await tools['contacts.create']!.handler(agentCtx, { name: 'Agent found' })) as ContactDto).shared).toBe(false)
    await setCompanyDefaultVisibility(f.deps, olga, 'team')
    expect(
      (
        (await tools['contacts.create']!.handler(agentCtx, {
          name: 'Agent found too',
        })) as ContactDto
      ).shared,
    ).toBe(true)
    expect((await createContact(f.deps, agent, { name: 'Direct' })).shared).toBe(true)
  })
})
