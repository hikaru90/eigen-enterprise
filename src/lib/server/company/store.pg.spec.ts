import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbCompanyProfileStore } from './store'

/**
 * The company profile store against real Postgres (the test DB). Needs
 * DATABASE_URL with migrations applied (0125); skipped without it. Uses the
 * one company row, so it clears it before and after.
 */

const url = process.env.DATABASE_URL?.trim()
const sha = (c: string) => c.repeat(64)

describe.skipIf(!url)('company profile store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })
  beforeEach(async () => {
    await sql`delete from company_profile`
  })
  afterAll(async () => {
    await sql`delete from company_profile`
    await sql.end()
  })

  it('has no profile until someone saves one', async () => {
    expect(await dbCompanyProfileStore(db).get()).toBeNull()
  })

  it('saves the name, then the logo, on the one row', async () => {
    const store = dbCompanyProfileStore(db)
    await store.setName('Kindred', 'u-owner')
    expect(await store.get()).toMatchObject({ name: 'Kindred', logo: null, updatedBy: 'u-owner' })
    expect(await store.setLogo({ sha256: sha('a'), mime: 'image/png' }, 'u-admin')).toEqual({ previous: null })
    expect(await store.get()).toMatchObject({ name: 'Kindred', logo: { sha256: sha('a'), mime: 'image/png' }, updatedBy: 'u-admin' })
    expect((await sql`select count(*)::int as n from company_profile`)[0].n).toBe(1)
  })

  it('replacing or removing the logo hands back the one it replaced, and keeps the name', async () => {
    const store = dbCompanyProfileStore(db)
    await store.setLogo({ sha256: sha('a'), mime: 'image/png' }, 'u1')
    expect(await store.setLogo({ sha256: sha('b'), mime: 'image/svg+xml' }, 'u1')).toEqual({
      previous: { sha256: sha('a'), mime: 'image/png' },
    })
    await store.setName('Kindred Labs', 'u1')
    expect(await store.setLogo(null, 'u1')).toEqual({ previous: { sha256: sha('b'), mime: 'image/svg+xml' } })
    expect(await store.get()).toMatchObject({ name: 'Kindred Labs', logo: null })
  })

  it('keeps a cropped logo’s original and crop, and hands them back when replaced', async () => {
    const store = dbCompanyProfileStore(db)
    const cropped = { sha256: sha('c'), mime: 'image/png' as const, original: { sha256: sha('d'), mime: 'image/jpeg' as const, crop: { left: -12.5, top: 3.25, size: 400 } } }
    await store.setLogo(cropped, 'u1')
    expect((await store.get())?.logo).toEqual(cropped)
    expect(await store.setLogo({ sha256: sha('e'), mime: 'image/svg+xml' }, 'u1')).toEqual({ previous: cropped })
    expect((await store.get())?.logo).toEqual({ sha256: sha('e'), mime: 'image/svg+xml' })
  })

  it('the table refuses half an original, or an original without a logo', async () => {
    await expect(
      sql`insert into company_profile (logo_sha256, logo_mime, logo_original_sha256, updated_by) values (${sha('a')}, 'image/png', ${sha('b')}, 'x')`,
    ).rejects.toThrow(/company_profile_logo_original_set_check/)
    await expect(
      sql`insert into company_profile (logo_original_sha256, logo_original_mime, logo_crop_left, logo_crop_top, logo_crop_size, updated_by)
          values (${sha('b')}, 'image/png', 0, 0, 10, 'x')`,
    ).rejects.toThrow(/company_profile_logo_original_set_check/)
    await expect(
      sql`insert into company_profile (logo_sha256, logo_mime, logo_original_sha256, logo_original_mime, logo_crop_left, logo_crop_top, logo_crop_size, updated_by)
          values (${sha('a')}, 'image/png', ${sha('b')}, 'image/svg+xml', 0, 0, 10, 'x')`,
    ).rejects.toThrow(/company_profile_logo_original_mime_check/)
  })

  it('the table refuses what the app never writes', async () => {
    await expect(sql`insert into company_profile (id, updated_by) values ('other', 'x')`).rejects.toThrow(/company_profile_singleton/)
    await expect(sql`insert into company_profile (name, updated_by) values ('  ', 'x')`).rejects.toThrow(/company_profile_name_check/)
    await expect(sql`insert into company_profile (logo_sha256, updated_by) values (${sha('a')}, 'x')`).rejects.toThrow(
      /company_profile_logo_pair_check/,
    )
    await expect(
      sql`insert into company_profile (logo_sha256, logo_mime, updated_by) values (${sha('a')}, 'image/gif', 'x')`,
    ).rejects.toThrow(/company_profile_logo_mime_check/)
  })
})
