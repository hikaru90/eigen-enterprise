import type { ContactMailPort, ContactsDeps } from '../../../../../../modules/contacts/service'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const live = vi.hoisted(() => ({ deps: null as ContactsDeps | null, mailWith: null as ContactMailPort | null }))
vi.mock('./contact-mail.server', () => ({
  liveContactMail: (userId: string, addresses: string[]) => live.mailWith!(userId, addresses),
}))
vi.mock('../../../../../../modules/contacts/live', () => ({
  contactsDeps: async () => live.deps,
  todayFor: async () => '2026-11-12',
  timeZoneFor: async () => 'Europe/Berlin',
}))

import { createContact, getContact } from '../../../../../../modules/contacts/service'
import { fixture, user } from '../../../../../../modules/contacts/test-fixtures'
import { actions, load } from './+page.server'
import { actions as detailActions, load as detailLoad } from './[id]/+page.server'
import { actions as importActions } from './import/+page.server'
import { actions as newActions } from './new/+page.server'

let f: ReturnType<typeof fixture>
beforeEach(() => {
  f = fixture()
  live.deps = f.deps
  live.mailWith = f.mailWith
})

const signedIn = (id: string) => ({ user: { id, email: `${id}@test` } })
const post = (entries: Array<[string, string]>) => {
  const body = new FormData()
  for (const [k, v] of entries) body.append(k, v)
  return new Request('http://os.test/m/email/people', { method: 'POST', body })
}

describe('/m/email/people', () => {
  it('sends signed-out visitors to /login', async () => {
    await expect(load({ locals: { user: null }, url: new URL('http://os.test/m/email/people') } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('lists what the person may see (tag + search), the tags to filter by and who to follow up with', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', tags: ['investor'], nextFollowUpOn: '2026-11-12' })
    await createContact(f.deps, user('ana'), { name: 'Jon Park', tags: ['production'] })
    await createContact(f.deps, user('ben'), { name: 'Bens private', tags: ['secret'], nextFollowUpOn: '2026-11-12' })
    const out = (await load({ locals: signedIn('ana'), url: new URL('http://os.test/m/email/people?tag=investor&q=voss') } as never)) as {
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

describe('/m/email/people/new', () => {
  it('adds a private contact (or a shared one when asked) and opens it', async () => {
    const made = newActions.default({
      locals: signedIn('ana'),
      request: post([['name', 'Mara Voss'], ['channelType', 'email'], ['channelValue', 'mara@northwind.example'], ['tag', 'investor']]),
    } as never)
    await expect(made).rejects.toMatchObject({ status: 303, location: expect.stringMatching(/^\/m\/email\/people\/[0-9a-f-]{36}$/) })
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

describe('/m/email/people/[id]', () => {
  it('is a 404 for someone who may not see it', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss' })
    await expect(detailLoad({ locals: signedIn('ben'), params: { id: mara.id } } as never)).rejects.toMatchObject({ status: 404 })
    expect(await detailLoad({ locals: signedIn('ana'), params: { id: mara.id } } as never)).toMatchObject({
      contact: { id: mara.id, own: true },
      today: '2026-11-12',
    })
  })

  it('loads the history: logged contacts (how it went) and mail the viewer may read', async () => {
    const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', channels: [{ type: 'email', value: 'mara@northwind.example' }] })
    const ctx = { locals: signedIn('ana'), params: { id: mara.id }, request: post([['on', '2026-11-11'], ['note', 'Coffee, liked it']]) } as never
    expect(await detailActions.log(ctx)).toEqual({ action: 'log', id: mara.id })
    f.mail.items = [
      { id: 'm1', direction: 'received', via: { kind: 'mailbox', address: 'ana@co.example' }, subject: 'Hi', snippet: null, at: new Date('2026-11-10T10:00:00Z'), href: '/x' },
    ]
    const out = (await detailLoad({ locals: signedIn('ana'), params: { id: mara.id } } as never)) as { history: Array<{ kind: string; id: string }> }
    expect(out.history.map((i) => i.kind)).toEqual(['added', 'logged', 'mail'])
    expect(out.history[1]).toMatchObject({ note: 'Coffee, liked it' })
    expect(f.mail.calls).toEqual([{ userId: 'ana', addresses: ['mara@northwind.example'] }])
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

    await expect(detailActions.delete(ctx([]))).rejects.toMatchObject({ status: 303, location: '/m/email/people' })
    expect(f.store.rows.size).toBe(0)
  })
})

describe('/m/email/people/import', () => {
  const candidates = (list: unknown) => post([['candidates', JSON.stringify(list)]])
  const mara = { name: 'Mara Voss', organisation: null, title: null, channels: [{ type: 'email', value: 'mara@northwind.example' }], metHow: null, whyRelevant: null, tags: [] }
  const jon = { ...mara, name: 'Jon Park', channels: [{ type: 'email', value: 'jon@atelier.example' }] }

  it('previews without saving: duplicates (by email) are reported', async () => {
    await createContact(f.deps, user('ana'), { name: 'Mara V.', channels: [{ type: 'email', value: 'mara@northwind.example' }] })
    const out = (await importActions.preview({ locals: signedIn('ana'), request: candidates([mara, jon]) } as never)) as {
      action: string
      preview: { counts: Record<string, number> }
    }
    expect(out).toMatchObject({ action: 'preview', preview: { counts: { new: 1, duplicate: 1, invalid: 0 } } })
    expect(f.store.rows.size).toBe(1)
  })

  it('imports what the person confirmed (shared when ticked) and reports the skipped ones', async () => {
    const out = (await importActions.import({
      locals: signedIn('ana'),
      request: post([['candidates', JSON.stringify([jon, mara])], ['shared', 'on']]),
    } as never)) as { action: string; imported: Array<{ id: string; name: string }>; skipped: number }
    expect(out).toMatchObject({ action: 'import', skipped: 0 })
    expect(out.imported.map((c) => c.name)).toEqual(['Jon Park', 'Mara Voss'])
    expect([...f.store.rows.values()].every((r) => r.shared)).toBe(true)
  })

  it('a body that is not JSON, or not a list, comes back to the page as an error', async () => {
    expect(await importActions.preview({ locals: signedIn('ana'), request: post([['candidates', '{nope']]) } as never)).toMatchObject({
      status: 400,
      data: { action: 'preview' },
    })
    expect(await importActions.import({ locals: signedIn('ana'), request: candidates({}) } as never)).toMatchObject({
      status: 400,
      data: { action: 'import' },
    })
  })

  it('sends signed-out visitors to /login', async () => {
    await expect(importActions.preview({ locals: { user: null }, request: candidates([mara]) } as never)).rejects.toMatchObject({ status: 302 })
  })
})
