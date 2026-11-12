import type { ContactsDeps } from '../../../../../modules/contacts/service'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const live = vi.hoisted(() => ({ deps: null as ContactsDeps | null }))
vi.mock('../../../../../modules/contacts/live', () => ({
  contactsDeps: async () => live.deps,
  todayFor: async () => '2026-11-12',
}))

import { createContact, getContact } from '../../../../../modules/contacts/service'
import { fixture, user } from '../../../../../modules/contacts/test-fixtures'
import { actions, load } from './+page.server'
import { actions as detailActions, load as detailLoad } from './[id]/+page.server'
import { actions as newActions } from './new/+page.server'

let f: ReturnType<typeof fixture>
beforeEach(() => {
  f = fixture()
  live.deps = f.deps
})

const signedIn = (id: string) => ({ user: { id, email: `${id}@test` } })
const post = (entries: Array<[string, string]>) => {
  const body = new FormData()
  for (const [k, v] of entries) body.append(k, v)
  return new Request('http://os.test/m/contacts', { method: 'POST', body })
}

describe('/m/contacts', () => {
  it('sends signed-out visitors to /login', async () => {
    await expect(load({ locals: { user: null }, url: new URL('http://os.test/m/contacts') } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('lists what the person may see (tag + search), the tags to filter by and who to follow up with', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', tags: ['investor'], nextFollowUpOn: '2026-11-12' })
    await createContact(f.deps, user('ana'), { name: 'Jon Park', tags: ['production'] })
    await createContact(f.deps, user('ben'), { name: 'Bens private', tags: ['secret'], nextFollowUpOn: '2026-11-12' })
    const out = (await load({ locals: signedIn('ana'), url: new URL('http://os.test/m/contacts?tag=investor&q=voss') } as never)) as {
      contacts: Array<{ id: string }>
      tags: string[]
      followUps: Array<{ id: string; due: string }>
      today: string
      filter: { tag: string; q: string }
    }
    expect(out.contacts.map((c) => c.id)).toEqual([mara.id])
    expect(out.tags).not.toContain('secret')
    expect(out.followUps.map((c) => [c.id, c.due])).toEqual([[mara.id, 'today']])
    expect(out.today).toBe('2026-11-12')
    expect(out.filter).toEqual({ tag: 'investor', q: 'voss' })
  })

  it('logs a contact from the follow-up list; a bad follow-up day comes back to that row', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', nextFollowUpOn: '2026-11-12' })
    const ok = await actions.log({ locals: signedIn('ana'), request: post([['id', mara.id], ['on', '2026-11-12'], ['nextFollowUpOn', '2026-11-30']]) } as never)
    expect(ok).toEqual({ action: 'log', id: mara.id })
    expect(await getContact(f.deps, user('ana'), mara.id)).toMatchObject({ lastContactedOn: '2026-11-12', nextFollowUpOn: '2026-11-30' })
    const bad = await actions.log({ locals: signedIn('ana'), request: post([['id', mara.id], ['on', '2026-11-12'], ['nextFollowUpOn', '2026-11-01']]) } as never)
    expect(bad).toMatchObject({ status: 400, data: { action: 'log', id: mara.id } })
  })
})

describe('/m/contacts/new', () => {
  it('adds a private contact (or a shared one when asked) and opens it', async () => {
    const made = newActions.default({
      locals: signedIn('ana'),
      request: post([['name', 'Mara Voss'], ['channelType', 'email'], ['channelValue', 'mara@northwind.example'], ['tag', 'investor']]),
    } as never)
    await expect(made).rejects.toMatchObject({ status: 303, location: expect.stringMatching(/^\/m\/contacts\/[0-9a-f-]{36}$/) })
    const [row] = [...f.store.rows.values()]
    expect(row).toMatchObject({ name: 'Mara Voss', shared: false, tags: ['investor'], channels: [{ type: 'email', value: 'mara@northwind.example' }] })

    await expect(newActions.default({ locals: signedIn('ana'), request: post([['name', 'Lee'], ['shared', 'on']]) } as never)).rejects.toMatchObject({ status: 303 })
    expect([...f.store.rows.values()].find((r) => r.name === 'Lee')?.shared).toBe(true)
  })

  it('a contact without a name comes back to the form', async () => {
    expect(await newActions.default({ locals: signedIn('ana'), request: post([['name', ' ']]) } as never)).toMatchObject({
      status: 400,
      data: { action: 'create' },
    })
  })
})

describe('/m/contacts/[id]', () => {
  it('is a 404 for someone who may not see it', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(detailLoad({ locals: signedIn('ben'), params: { id: mara.id } } as never)).rejects.toMatchObject({ status: 404 })
    expect(await detailLoad({ locals: signedIn('ana'), params: { id: mara.id } } as never)).toMatchObject({
      contact: { id: mara.id, own: true },
      today: '2026-11-12',
    })
  })

  it('saves, shares, logs and deletes', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', organisation: 'Northwind' })
    const ctx = (entries: Array<[string, string]>) => ({ locals: signedIn('ana'), params: { id: mara.id }, request: post(entries) }) as never
    expect(await detailActions.save(ctx([['name', 'Mara Voss'], ['organisation', ''], ['title', 'Partner']]))).toEqual({ action: 'save', id: mara.id })
    expect(await getContact(f.deps, user('ana'), mara.id)).toMatchObject({ organisation: null, title: 'Partner' })

    await detailActions.share(ctx([['shared', 'true']]))
    expect((await getContact(f.deps, user('ben'), mara.id)).shared).toBe(true)
    expect(
      await detailActions.share({ locals: signedIn('ben'), params: { id: mara.id }, request: post([['shared', 'false']]) } as never),
    ).toMatchObject({ status: 403 })

    await detailActions.log(ctx([['id', mara.id], ['on', '2026-11-12']]))
    expect((await getContact(f.deps, user('ana'), mara.id)).lastContactedOn).toBe('2026-11-12')

    await expect(detailActions.delete(ctx([]))).rejects.toMatchObject({ status: 303, location: '/m/contacts' })
    expect(f.store.rows.size).toBe(0)
  })
})
