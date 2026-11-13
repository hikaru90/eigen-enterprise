import type { ImportCandidate } from './types'
import { describe, expect, it } from 'vitest'
import { createContact, importContacts, listContacts, previewImport } from './service'
import { agent, fixture, user } from './test-fixtures'

/**
 * Import: a preview first (nothing saved), then the import the person
 * confirms. Every candidate is checked like a typed contact; one already
 * known by email (to the importer) is reported, never overwritten, and not
 * imported again.
 */

const candidate = (over: Partial<ImportCandidate> = {}): ImportCandidate => ({
  name: 'Mara Voss',
  organisation: null,
  title: null,
  channels: [],
  metHow: null,
  whyRelevant: null,
  tags: [],
  ...over,
})

describe('previewImport', () => {
  it('checks every row: new, duplicate by email (yours, shared, or earlier in the file), or not importable — and saves nothing', async () => {
    const f = fixture()
    const known = await createContact(f.deps, user('ana'), { name: 'Mara V.', channels: [{ type: 'email', value: 'mara@northwind.example' }] })
    await createContact(f.deps, user('ben'), { name: 'Bens private', channels: [{ type: 'email', value: 'lee@private.example' }] })
    const before = f.store.rows.size
    const out = await previewImport(f.deps, user('ana'), [
      candidate({ channels: [{ type: 'email', value: ' MARA@northwind.example ' }] }),
      candidate({ name: 'Jon Park', channels: [{ type: 'email', value: 'jon@atelier.example' }], tags: ['Production', 'Berlin'] }),
      candidate({ name: 'Jon again', channels: [{ type: 'email', value: 'Jon@Atelier.example' }] }),
      candidate({ name: '  ' }),
      // Ben's private contact is not Ana's to know about: not a duplicate for her.
      candidate({ name: 'Lee', channels: [{ type: 'email', value: 'lee@private.example' }] }),
      candidate({ name: 'No mail' }),
    ])
    expect(out.rows.map((r) => [r.index, r.status])).toEqual([
      [0, 'duplicate'],
      [1, 'new'],
      [2, 'duplicate'],
      [3, 'invalid'],
      [4, 'new'],
      [5, 'new'],
    ])
    expect(out.rows[0]).toMatchObject({ email: 'mara@northwind.example', existing: { id: known.id, name: 'Mara V.' } })
    expect(out.rows[1]).toMatchObject({ contact: { name: 'Jon Park', tags: ['production', 'berlin'] } })
    expect(out.rows[2]).toMatchObject({ email: 'jon@atelier.example', existing: null })
    expect(out.rows[3]).toMatchObject({ error: 'Give the contact a name.' })
    expect(out.counts).toEqual({ new: 3, duplicate: 2, invalid: 1 })
    expect(f.store.rows.size).toBe(before)
    expect(f.events.filter((e) => e.type === 'contacts.imported')).toEqual([])
  })

  it('a row over a limit says which limit', async () => {
    const f = fixture()
    const out = await previewImport(f.deps, user('ana'), [candidate({ title: 'x'.repeat(201) })])
    expect(out.rows[0]).toMatchObject({ status: 'invalid', name: 'Mara Voss', error: 'A role or title can be at most 200 characters.' })
  })

  it('refuses what is not a list of candidates, an empty list and more than the most one import adds', async () => {
    const f = fixture()
    await expect(previewImport(f.deps, user('ana'), { name: 'x' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(previewImport(f.deps, user('ana'), [])).rejects.toMatchObject({ code: 'invalid' })
    await expect(previewImport(f.deps, user('ana'), Array.from({ length: 501 }, () => candidate()))).rejects.toMatchObject({ code: 'invalid' })
    await expect(previewImport(f.deps, user('ana'), [{ ...candidate(), shared: true }])).rejects.toMatchObject({ code: 'invalid' })
  })

  it('is for people in the company', async () => {
    const f = fixture()
    await expect(previewImport(f.deps, user('stranger'), [candidate()])).rejects.toMatchObject({ code: 'forbidden' })
    await expect(previewImport(f.deps, agent, [candidate()])).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('importContacts', () => {
  it('adds the new ones together (private unless shared), reports the duplicates and leaves the known contact untouched', async () => {
    const f = fixture()
    const known = await createContact(f.deps, user('ana'), {
      name: 'Mara V.',
      organisation: 'Old Org',
      channels: [{ type: 'email', value: 'mara@northwind.example' }],
    })
    const out = await importContacts(
      f.deps,
      user('ana'),
      [
        candidate({ organisation: 'New Org', channels: [{ type: 'email', value: 'mara@northwind.example' }] }),
        candidate({ name: 'Jon Park', organisation: 'Atelier', channels: [{ type: 'email', value: 'jon@atelier.example' }] }),
        candidate({ name: 'Zoë' }),
      ],
      { shared: true },
    )
    expect(out.created.map((c) => [c.name, c.shared, c.own])).toEqual([
      ['Jon Park', true, true],
      ['Zoë', true, true],
    ])
    expect(out.skipped).toEqual([expect.objectContaining({ index: 0, status: 'duplicate', existing: { id: known.id, name: 'Mara V.' } })])
    expect((await listContacts(f.deps, user('ana'))).contacts.find((c) => c.id === known.id)).toMatchObject({ organisation: 'Old Org' })
    expect(f.events.at(-1)).toEqual({
      type: 'contacts.imported',
      principalId: 'ana',
      payload: { ids: out.created.map((c) => c.id), shared: true, skipped: 1 },
    })
  })

  it('a row that is not importable stops the whole import: nothing is added', async () => {
    const f = fixture()
    await expect(
      importContacts(f.deps, user('ana'), [candidate({ name: 'Fine' }), candidate({ name: '' })], { shared: false }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('Row 2') })
    expect(f.store.rows.size).toBe(0)
  })

  it('nothing new (all already known) adds nothing and says so', async () => {
    const f = fixture()
    await createContact(f.deps, user('ana'), { name: 'Mara', channels: [{ type: 'email', value: 'mara@northwind.example' }] })
    const out = await importContacts(f.deps, user('ana'), [candidate({ channels: [{ type: 'email', value: 'mara@northwind.example' }] })], {
      shared: false,
    })
    expect(out.created).toEqual([])
    expect(out.skipped).toHaveLength(1)
    expect(f.events.filter((e) => e.type === 'contacts.imported')).toEqual([])
  })
})
