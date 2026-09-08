import { getTableName } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { DbWebsiteStore, InMemoryWebsiteStore, type WebsiteStore } from './store'

/**
 * Shared behaviour suite for every WebsiteStore implementation: in-memory
 * fakes (unit tests) and the drizzle-backed store (fake db handle).
 */
function storeBehavior(name: string, makeStore: () => WebsiteStore) {
  describe(name, () => {
    it('createPage stores the page with defaults (kind page, visibility private)', async () => {
      const store = makeStore()
      const page = await store.createPage({ slug: 'about', title: 'About', body: '# About us' })

      expect(page.slug).toBe('about')
      expect(page.title).toBe('About')
      expect(page.body).toBe('# About us')
      expect(page.kind).toBe('page')
      expect(page.visibility).toBe('private')
      expect(page.id).toBeTruthy()
      expect(page.createdAt).toBeTruthy()
      expect(page.updatedAt).toBeTruthy()
    })

    it('createPage accepts explicit kind and visibility', async () => {
      const store = makeStore()
      const page = await store.createPage({
        slug: 'handbook',
        title: 'Handbook',
        body: 'contents',
        kind: 'doc',
        visibility: 'public',
      })

      expect(page.kind).toBe('doc')
      expect(page.visibility).toBe('public')
    })

    it('createPage throws loud on duplicate slug', async () => {
      const store = makeStore()
      await store.createPage({ slug: 'about', title: 'About', body: 'x' })

      await expect(
        store.createPage({ slug: 'about', title: 'Again', body: 'y' }),
      ).rejects.toThrow(/duplicate website slug: about/)
    })

    it('getPage returns the stored page and null for unknown slugs', async () => {
      const store = makeStore()
      await store.createPage({ slug: 'about', title: 'About', body: 'x' })

      expect((await store.getPage('about'))?.title).toBe('About')
      expect(await store.getPage('nope')).toBeNull()
    })

    it('updatePage patches title and body and bumps updatedAt', async () => {
      const store = makeStore()
      const before = await store.createPage({ slug: 'about', title: 'About', body: 'x' })

      const after = await store.updatePage('about', { title: 'About us', body: 'y' })

      expect(after.title).toBe('About us')
      expect(after.body).toBe('y')
      expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(before.updatedAt).getTime(),
      )
      expect((await store.getPage('about'))?.title).toBe('About us')
    })

    it('updatePage allows partial patches', async () => {
      const store = makeStore()
      await store.createPage({ slug: 'about', title: 'About', body: 'x' })

      const after = await store.updatePage('about', { body: 'new body' })

      expect(after.title).toBe('About')
      expect(after.body).toBe('new body')
    })

    it('updatePage throws loud for an unknown slug', async () => {
      const store = makeStore()

      await expect(store.updatePage('nope', { title: 'x' })).rejects.toThrow(
        /unknown website page: nope/,
      )
    })

    it('setVisibility flips visibility and is readable back', async () => {
      const store = makeStore()
      await store.createPage({ slug: 'about', title: 'About', body: 'x' })

      const published = await store.setVisibility('about', 'public')
      expect(published.visibility).toBe('public')
      expect((await store.getPage('about'))?.visibility).toBe('public')

      const unpublished = await store.setVisibility('about', 'private')
      expect(unpublished.visibility).toBe('private')
    })

    it('setVisibility throws loud for an unknown slug', async () => {
      const store = makeStore()

      await expect(store.setVisibility('nope', 'public')).rejects.toThrow(
        /unknown website page: nope/,
      )
    })

    it('listPages returns all pages and filters by kind and visibility', async () => {
      const store = makeStore()
      await store.createPage({ slug: 'home', title: 'Home', body: 'x', visibility: 'public' })
      await store.createPage({ slug: 'about', title: 'About', body: 'x' })
      await store.createPage({ slug: 'handbook', title: 'Handbook', body: 'x', kind: 'doc' })

      expect((await store.listPages()).map((p) => p.slug).sort()).toEqual([
        'about',
        'handbook',
        'home',
      ])
      expect((await store.listPages({ kind: 'doc' })).map((p) => p.slug)).toEqual(['handbook'])
      expect((await store.listPages({ visibility: 'public' })).map((p) => p.slug)).toEqual(['home'])
      expect(
        (await store.listPages({ kind: 'page', visibility: 'private' })).map((p) => p.slug).sort(),
      ).toEqual(['about'])
      expect(await store.listPages({ kind: 'doc', visibility: 'public' })).toEqual([])
    })

    it('createContact stores the contact with defaults and returns it', async () => {
      const store = makeStore()
      const contact = await store.createContact({
        name: 'Jane Doe',
        email: 'jane@example.com',
        message: 'Hello',
      })

      expect(contact.id).toBeTruthy()
      expect(contact.name).toBe('Jane Doe')
      expect(contact.email).toBe('jane@example.com')
      expect(contact.message).toBe('Hello')
      expect(contact.source).toBe('website')
      expect(contact.principalId).toBeNull()
      expect(contact.createdAt).toBeTruthy()
    })

    it('createContact stores name/message as null when absent and keeps a principal id when given', async () => {
      const store = makeStore()
      const anonymous = await store.createContact({ email: 'j@example.com' })
      expect(anonymous.name).toBeNull()
      expect(anonymous.message).toBeNull()

      const attributed = await store.createContact({
        email: 'k@example.com',
        principalId: 'principal-1',
      })
      expect(attributed.principalId).toBe('principal-1')
    })
  })
}

storeBehavior('InMemoryWebsiteStore', () => new InMemoryWebsiteStore())

/**
 * Sequence-observing fake of the drizzle builder surface used by
 * DbWebsiteStore: selects replay configurable rows, inserts/updates replay a
 * configurable returning row. Dispatches on table name; fails loud on
 * unexpected tables.
 */
function makeFakeDb(options: { selectRows?: () => unknown[]; returningRow?: unknown } = {}) {
  const calls: Array<{
    op: 'insert' | 'select' | 'update'
    table: string
    values?: unknown
    set?: unknown
  }> = []

  function tableName(table: unknown): string {
    const name = getTableName(table as never)
    if (!name) throw new Error('fake db: unknown table')
    return name
  }

  const db = {
    insert(table: unknown) {
      const name = tableName(table)
      return {
        values(values: unknown) {
          calls.push({ op: 'insert', table: name, values })
          return { returning: async () => [options.returningRow ?? {}] }
        },
      }
    },
    select() {
      return {
        from(table: unknown) {
          const name = tableName(table)
          calls.push({ op: 'select', table: name })
          const node = {
            where: () => node,
            orderBy: () => node,
            limit: () => node,
            then: (
              resolve: (rows: unknown[]) => unknown,
              reject: (err: unknown) => unknown,
            ) => Promise.resolve(options.selectRows?.() ?? []).then(resolve, reject),
          }
          return node
        },
      }
    },
    update(table: unknown) {
      const name = tableName(table)
      return {
        set(set: unknown) {
          return {
            where: () => ({
              returning: async () => {
                calls.push({ op: 'update', table: name, set })
                return [options.returningRow ?? {}]
              },
            }),
          }
        },
      }
    },
  }

  return { db: db as unknown as AppDatabase, calls }
}

const dbRow = {
  id: 'row-1',
  slug: 'about',
  kind: 'page',
  title: 'About',
  body: 'x',
  visibility: 'public',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
}

describe('DbWebsiteStore', () => {
  it('createPage checks slug uniqueness first and throws loud when taken', async () => {
    const fake = makeFakeDb({ selectRows: () => [{ id: 'taken' }] })
    const store = new DbWebsiteStore(fake.db)

    await expect(
      store.createPage({ slug: 'about', title: 'About', body: 'x' }),
    ).rejects.toThrow(/duplicate website slug: about/)
    expect(fake.calls.map((c) => c.op)).toEqual(['select'])
    expect(fake.calls[0].table).toBe('website_content')
  })

  it('createPage inserts with domain values and maps the returned row', async () => {
    const fake = makeFakeDb({ selectRows: () => [], returningRow: dbRow })
    const store = new DbWebsiteStore(fake.db)

    const page = await store.createPage({ slug: 'about', title: 'About', body: 'x' })

    expect(page).toMatchObject({
      id: 'row-1',
      slug: 'about',
      kind: 'page',
      title: 'About',
      visibility: 'public',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(fake.calls.map((c) => c.op)).toEqual(['select', 'insert'])
    expect(fake.calls[1]).toMatchObject({ op: 'insert', table: 'website_content' })
    expect(fake.calls[1].values).toMatchObject({
      slug: 'about',
      kind: 'page',
      title: 'About',
      body: 'x',
      visibility: 'private',
    })
  })

  it('getPage returns null for an empty select and maps a found row', async () => {
    const missing = makeFakeDb({ selectRows: () => [] })
    expect(await new DbWebsiteStore(missing.db).getPage('about')).toBeNull()

    const found = makeFakeDb({ selectRows: () => [dbRow] })
    const page = await new DbWebsiteStore(found.db).getPage('about')
    expect(page?.id).toBe('row-1')
    expect(page?.visibility).toBe('public')
  })

  it('updatePage throws loud when the slug is unknown (empty select)', async () => {
    const fake = makeFakeDb({ selectRows: () => [] })
    const store = new DbWebsiteStore(fake.db)

    await expect(store.updatePage('nope', { title: 'x' })).rejects.toThrow(
      /unknown website page: nope/,
    )
    expect(fake.calls.map((c) => c.op)).toEqual(['select'])
  })

  it('updatePage writes only the provided fields plus updatedAt', async () => {
    const fake = makeFakeDb({ selectRows: () => [dbRow], returningRow: dbRow })
    const store = new DbWebsiteStore(fake.db)

    await store.updatePage('about', { body: 'new body' })

    expect(fake.calls.at(-1)).toMatchObject({ op: 'update', table: 'website_content' })
    expect(fake.calls.at(-1)?.set).toMatchObject({ body: 'new body' })
    expect((fake.calls.at(-1)?.set as { title?: unknown }).title).toBeUndefined()
    expect((fake.calls.at(-1)?.set as { updatedAt: unknown }).updatedAt).toBeInstanceOf(Date)
  })

  it('setVisibility writes the visibility column plus updatedAt', async () => {
    const fake = makeFakeDb({ selectRows: () => [dbRow], returningRow: dbRow })
    const store = new DbWebsiteStore(fake.db)

    await store.setVisibility('about', 'private')

    expect(fake.calls.at(-1)).toMatchObject({ op: 'update', table: 'website_content' })
    expect(fake.calls.at(-1)?.set).toMatchObject({ visibility: 'private' })
  })

  it('listPages selects the content table', async () => {
    const fake = makeFakeDb({ selectRows: () => [dbRow] })
    const store = new DbWebsiteStore(fake.db)

    const pages = await store.listPages({ kind: 'page' })

    expect(pages).toHaveLength(1)
    expect(fake.calls[0]).toMatchObject({ op: 'select', table: 'website_content' })
  })

  it('createContact inserts with defaults and maps the returned row', async () => {
    const fake = makeFakeDb({
      returningRow: {
        id: 'contact-1',
        name: 'Jane',
        email: 'jane@example.com',
        message: 'Hello',
        source: 'website',
        principalId: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const store = new DbWebsiteStore(fake.db)

    const contact = await store.createContact({ email: 'jane@example.com' })

    expect(contact.id).toBe('contact-1')
    expect(contact.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(fake.calls[0]).toMatchObject({ op: 'insert', table: 'website_contact' })
    expect(fake.calls[0].values).toMatchObject({
      email: 'jane@example.com',
      source: 'website',
    })
    expect((fake.calls[0].values as { principalId?: unknown }).principalId).toBeNull()
  })
})
