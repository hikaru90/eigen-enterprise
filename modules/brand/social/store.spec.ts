import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { DbSocialPostStore, InMemorySocialPostStore, type SocialPostStore } from './store'

/**
 * The social post library contract, on the in-memory store and — with
 * DATABASE_URL (the test DB, migration 0153 applied) — on Postgres.
 */

const person = { kind: 'user' as const, userId: 'ana' }
const agent = { kind: 'agent' as const, id: 'orchestrator' }
const sha = (c: string) => c.repeat(64)

const graphic = {
  title: 'Launch teaser',
  format: 'portrait' as const,
  graphic: { headline: 'Something new is coming', body: 'Next week.', cta: 'Stay tuned', mode: 'light' as const },
  networks: ['instagram' as const, 'linkedin' as const],
}

function contract(name: string, make: () => SocialPostStore, cleanup?: (ids: string[]) => Promise<void>) {
  describe(name, () => {
    const ids: string[] = []
    let store: SocialPostStore
    beforeAll(() => {
      store = make()
    })
    afterAll(async () => {
      await cleanup?.(ids)
    })

    it('creates a graphic post as a draft with its copy, format and networks', async () => {
      const post = await store.createGraphic(graphic, agent)
      ids.push(post.id)
      expect(post).toMatchObject({
        title: 'Launch teaser',
        source: 'graphic',
        format: 'portrait',
        graphic: graphic.graphic,
        networks: ['instagram', 'linkedin'],
        captions: {},
        status: 'draft',
        plannedFor: null,
        media: [],
        createdBy: 'orchestrator',
        createdByKind: 'agent',
      })
      await expect(store.get(post.id)).resolves.toMatchObject({ id: post.id, title: 'Launch teaser' })
    })

    it('refuses a caption for a network the post does not target', async () => {
      await expect(store.createGraphic({ ...graphic, captions: { x: 'Hi' } }, person)).rejects.toThrow(/does not target/)
    })

    it('stores an uploaded carousel with its files in order', async () => {
      const post = await store.createUpload(
        { title: 'Team day', networks: ['instagram'], captions: { instagram: 'Our day out' }, status: 'ready', plannedFor: '2026-12-01' },
        [
          { name: 'one.jpg', mime: 'image/jpeg', size: 10, sha256: sha('a') },
          { name: 'two.jpg', mime: 'image/jpeg', size: 12, sha256: sha('b') },
        ],
        person,
      )
      ids.push(post.id)
      expect(post).toMatchObject({ source: 'upload', format: null, graphic: null, status: 'ready', plannedFor: '2026-12-01', createdByKind: 'user' })
      expect(post.media.map((m) => [m.position, m.name])).toEqual([
        [0, 'one.jpg'],
        [1, 'two.jpg'],
      ])
      await expect(store.getMedia(post.media[1].id)).resolves.toMatchObject({ name: 'two.jpg', sha256: sha('b') })
      await expect(store.blobInUse(sha('b'))).resolves.toBe(true)
    })

    it('an upload without files fails loud', async () => {
      await expect(store.createUpload({ title: 'Empty', networks: ['x'] }, [], person)).rejects.toThrow(/at least one file/)
    })

    it('updates captions, status and day; captions follow the networks', async () => {
      const post = await store.createGraphic({ ...graphic, captions: { instagram: 'IG', linkedin: 'LI' } }, person)
      ids.push(post.id)
      const next = await store.update({ postId: post.id, status: 'ready', plannedFor: '2026-12-24', networks: ['linkedin', 'x'] })
      expect(next).toMatchObject({ status: 'ready', plannedFor: '2026-12-24', networks: ['linkedin', 'x'], captions: { linkedin: 'LI' } })
      await expect(store.update({ postId: post.id, captions: { instagram: 'IG again' } })).rejects.toThrow(/does not target/)
      const captioned = await store.update({ postId: post.id, captions: { x: 'Short one' } })
      expect(captioned.captions).toEqual({ x: 'Short one' })
      await expect(store.update({ postId: post.id, plannedFor: null })).resolves.toMatchObject({ plannedFor: null })
    })

    it('an uploaded post has no graphic to change', async () => {
      const post = await store.createUpload({ title: 'Clip', networks: ['tiktok'] }, [{ name: 'c.mp4', mime: 'video/mp4', size: 99, sha256: sha('c') }], person)
      ids.push(post.id)
      await expect(store.update({ postId: post.id, format: 'square' })).rejects.toThrow(/no graphic or format/)
    })

    it('lists newest first, by status', async () => {
      const all = await store.list()
      expect(all.length).toBeGreaterThanOrEqual(4)
      const ours = all.filter((p) => ids.includes(p.id))
      expect(ours[0].createdAt >= ours[ours.length - 1].createdAt).toBe(true)
      const ready = await store.list({ status: 'ready' })
      expect(ready.every((p) => p.status === 'ready')).toBe(true)
    })

    it('removing a post returns its media and frees the bytes', async () => {
      const post = await store.createUpload({ title: 'Gone', networks: ['facebook'] }, [{ name: 'g.png', mime: 'image/png', size: 5, sha256: sha('d') }], person)
      const media = await store.remove(post.id)
      expect(media.map((m) => m.sha256)).toEqual([sha('d')])
      await expect(store.get(post.id)).resolves.toBeNull()
      await expect(store.blobInUse(sha('d'))).resolves.toBe(false)
      await expect(store.remove(post.id)).rejects.toThrow(/No social post/)
    })

    it('an unknown post is a not_found error', async () => {
      await expect(store.update({ postId: '00000000-0000-4000-8000-000000000000', status: 'posted' })).rejects.toMatchObject({ code: 'not_found' })
    })
  })
}

contract('InMemorySocialPostStore', () => new InMemorySocialPostStore())

const url = process.env.DATABASE_URL?.trim()
if (url) {
  let sql: postgres.Sql
  contract(
    'DbSocialPostStore (Postgres)',
    () => {
      sql = postgres(url, { prepare: false, max: 2, onnotice: () => {} })
      return new DbSocialPostStore(drizzle(sql) as unknown as AppDatabase)
    },
    async (ids) => {
      if (ids.length) await sql`delete from brand_social_posts where id in ${sql(ids)}`
      await sql.end()
    },
  )
}
