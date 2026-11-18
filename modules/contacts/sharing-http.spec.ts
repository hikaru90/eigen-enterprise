import { describe, expect, it } from 'vitest'
import { contactsSharingResponse } from './http'
import { createContact, getContact } from './service'
import { fixture, user } from './test-fixtures'

/** POST /api/contacts/sharing over the in-memory store: one call for many contacts, permission skips reported. */

const post = (body: unknown) =>
  new Request('http://x/api/contacts/sharing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('contacts sharing endpoint', () => {
  it('signed out is a 401', async () => {
    const f = fixture()
    expect((await contactsSharingResponse(null, post({}), async () => f.deps)).status).toBe(401)
  })

  it('shares the chosen ones that are yours and says which were skipped', async () => {
    const f = fixture()
    const mine = await createContact(f.deps, user('ana'), { name: 'Mine' })
    const bens = await createContact(f.deps, user('ben'), { name: 'Bens' }, { shared: true })
    const res = await contactsSharingResponse(
      { id: 'ana' },
      post({ action: 'share', ids: [mine.id, bens.id], targets: { team: true } }),
      async () => f.deps,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      changed: [mine.id],
      skipped: [{ id: bens.id, name: 'Bens', reason: 'not_yours' }],
    })
    expect((await getContact(f.deps, user('ben'), mine.id)).shared).toBe(true)

    const back = await contactsSharingResponse({ id: 'ana' }, post({ action: 'private', ids: [mine.id] }), async () => f.deps)
    expect(await back.json()).toEqual({ changed: [mine.id], skipped: [] })
    expect((await getContact(f.deps, user('ana'), mine.id)).shared).toBe(false)
  })

  it('a bad request is a 400 with the reason; someone outside the company a 403', async () => {
    const f = fixture()
    const mine = await createContact(f.deps, user('ana'), { name: 'Mine' })
    const bad = await contactsSharingResponse({ id: 'ana' }, post({ action: 'share', ids: [mine.id], targets: {} }), async () => f.deps)
    expect(bad.status).toBe(400)
    expect(await bad.json()).toMatchObject({ code: 'invalid' })
    expect((await contactsSharingResponse({ id: 'ana' }, post({ action: 'delete', ids: [mine.id] }), async () => f.deps)).status).toBe(400)
    expect((await contactsSharingResponse({ id: 'ana' }, post('not json'), async () => f.deps)).status).toBe(400)
    expect(
      (await contactsSharingResponse({ id: 'stranger' }, post({ action: 'private', ids: [mine.id] }), async () => f.deps)).status,
    ).toBe(403)
  })
})
