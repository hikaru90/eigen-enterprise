import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Memory's documents are Drive files (wish f3fc516e, drizzle/0191), on the
 * test database as the app's RLS role with the live Drive (blobs in a temp
 * dir): a document is a Markdown file in its owner's My drive, shared with
 * the company by a view grant or private; the brain's index keeps searching
 * it; old text files are copied over once, links and all.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

describe.skipIf(!DATABASE_URL)('Memory documents in Drive', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const ana = `doc_ana_${tag}`
  const ben = `doc_ben_${tag}`
  const boss = `doc_admin_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let svc: typeof import('./service')
  let driveMod: typeof import('../../../../modules/drive')
  let dir: string

  const as = <T>(user: string, fn: () => Promise<T>) => db.withDbUser(user, fn)
  const user = (userId: string) => ({ kind: 'user' as const, userId })

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ee-memory-docs-'))
    process.env.DRIVE_STORAGE_DIR = dir
    db = await import('$lib/server/db')
    svc = await import('./service')
    driveMod = await import('../../../../modules/drive')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const [id, role] of [
      [ana, 'member'],
      [ben, 'member'],
      [boss, 'admin'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${`${role} ${id.slice(4, 7)}`}, ${`${id}@test.local`}, true, true, ${role})`
    }
  })

  afterAll(async () => {
    await operator`delete from access_grant where resource_type = 'file' and resource_id in (select id from drive_file where owner_id in (${ana}, ${ben}, ${boss}))`
    await operator`delete from drive_revision where file_id in (select id from drive_file where owner_id in (${ana}, ${ben}, ${boss}))`
    await operator`delete from drive_file where owner_id in (${ana}, ${ben}, ${boss})`
    await operator`delete from "user" where id in (${ana}, ${ben}, ${boss})`
    await operator.end()
    await db.closeAppDbPool()
    await rm(dir, { recursive: true, force: true })
  })

  it('a new document is a Markdown file in its owner’s Drive, shared with the company by default', async () => {
    const doc = await as(ana, () =>
      svc.createTextFile(ana, { title: 'Launch / plan', body: 'DNS, analytics, redirects' }),
    )
    expect(doc).toMatchObject({
      title: 'Launch / plan',
      body: 'DNS, analytics, redirects',
      ownerId: ana,
      visibility: 'company',
      editable: true,
    })
    const drive = await driveMod.driveService()
    const read = await drive.readText(user(ana), doc.id)
    expect(read.file.name).toBe('Launch - plan.md')
    expect(read.content).toBe('DNS, analytics, redirects')
    // A colleague reads it in Drive and in Memory, read-only.
    expect((await drive.readText(user(ben), doc.id)).content).toBe('DNS, analytics, redirects')
    await expect(drive.writeText(user(ben), doc.id, 'mine now')).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(await as(ben, () => svc.getTextFile(ben, doc.id))).toMatchObject({
      body: 'DNS, analytics, redirects',
      editable: false,
      ownerId: ana,
    })
    await expect(as(ben, () => svc.updateTextFile(ben, doc.id, { body: 'x' }))).rejects.toThrow(
      /read-only/,
    )
  })

  it('a private document is its owner’s alone in Memory — no admin override — and in Drive only owner and admins', async () => {
    const doc = await as(ana, () =>
      svc.createTextFile(ana, { title: 'Salary notes', body: 'my number', visibility: 'private' }),
    )
    const drive = await driveMod.driveService()
    await expect(drive.readText(user(ben), doc.id)).rejects.toMatchObject({ code: 'not_found' })
    for (const reader of [ben, boss]) {
      expect(await as(reader, () => svc.getTextFile(reader, doc.id))).toBeNull()
      expect(
        (await as(reader, () => svc.searchTextFiles(reader, { query: 'salary' }))).map((h) => h.id),
      ).not.toContain(doc.id)
    }
    // Sharing it later opens it for colleagues (a company view grant); private again closes it.
    await as(ana, () => svc.setTextFileVisibility(ana, doc.id, 'company'))
    expect((await drive.readText(user(ben), doc.id)).content).toBe('my number')
    expect(await as(ben, () => svc.getTextFile(ben, doc.id))).toMatchObject({
      visibility: 'company',
    })
    await as(ana, () => svc.setTextFileVisibility(ana, doc.id, 'private'))
    await expect(drive.readText(user(ben), doc.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('edits write a Drive revision and the brain searches the new text — also after an edit in Drive itself', async () => {
    const doc = await as(ana, () => svc.createTextFile(ana, { title: 'Shopping', body: 'milk' }))
    await as(ana, () => svc.appendTextFile(ana, doc.id, { text: 'bread' }))
    await as(ana, () => svc.updateTextFile(ana, doc.id, { title: 'Groceries' }))
    const drive = await driveMod.driveService()
    const read = await drive.readText(user(ana), doc.id)
    expect(read).toMatchObject({ content: 'milk\nbread', file: { name: 'Groceries.md' } })
    expect((await drive.listRevisions(user(ana), doc.id)).length).toBeGreaterThanOrEqual(2)
    expect(
      (await as(ana, () => svc.searchTextFiles(ana, { query: 'bread' }))).map((h) => h.id),
    ).toContain(doc.id)
    // Someone edits the file in Drive's editor: the brain follows.
    await drive.writeText(user(ana), doc.id, 'oat milk and avocados')
    expect(
      (await as(ana, () => svc.searchTextFiles(ana, { query: 'avocados' }))).map((h) => h.id),
    ).toContain(doc.id)
    expect(
      (await as(ana, () => svc.searchTextFiles(ana, { query: 'bread' }))).map((h) => h.id),
    ).not.toContain(doc.id)
  })

  it('links to thoughts show the document on the thought and on its project; deleting trashes the Drive file', async () => {
    const { createUserDeclaredProject } = await import('$lib/server/memory/create-user-project')
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const { linkThoughtToProject } = await import('$lib/server/memory/project-next-action')
    const { project, thoughtId, doc } = await as(ana, async () => {
      const project = (await createUserDeclaredProject({ userId: ana, label: `Relaunch ${tag}` }))
        .entityId
      const thoughtId = (
        await queueCapture(ana, 'Draft the relaunch copy', { skipWorker: true, category: 'task' })
      ).thoughtId
      await linkThoughtToProject(ana, project, thoughtId)
      const doc = await svc.createTextFile(ana, { title: 'Relaunch copy', body: 'Hello world' })
      expect(await svc.linkTextFileToThought(ana, thoughtId, doc.id)).toEqual({ linked: true })
      return { project, thoughtId, doc }
    })
    expect(
      (await as(ana, () => svc.listTextFilesForThought(ana, thoughtId))).map((f) => f.id),
    ).toEqual([doc.id])
    expect((await as(ana, () => svc.listProjectDocuments(ana, project))).map((f) => f.id)).toEqual([
      doc.id,
    ])
    expect(
      (await as(ana, () => svc.listThoughtsForTextFile(ana, doc.id))).map((t) => t.id),
    ).toEqual([thoughtId])

    expect(await as(ana, () => svc.deleteTextFile(ana, doc.id))).toBe(true)
    expect(await as(ana, () => svc.getTextFile(ana, doc.id))).toBeNull()
    const drive = await driveMod.driveService()
    expect((await drive.trash(user(ana))).map((i) => i.id)).toContain(doc.id)
  })

  it('copies every old text file into Drive once: owner, text, sharing, authorship, times and thought links', async () => {
    const { encryptTenantValue } = await import('$lib/server/crypto/tenant-encryption')
    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    const created = new Date('2026-03-01T09:00:00.000Z')
    const { sharedOld, privateOld, thoughtId } = await as(ben, async () => {
      const thoughtId = (await queueCapture(ben, 'Remember the vendor list', { skipWorker: true }))
        .thoughtId
      const seal = (plaintext: string, scope: 'company' | 'person') =>
        encryptTenantValue({
          userId: ben,
          table: 'text_file',
          column: 'body_text',
          plaintext,
          scope,
        })
      const [s] = await db.getDb().execute<{ id: string }>(
        (await import('drizzle-orm'))
          .sql`insert into text_file (user_id, title, body_text, body_text_encrypted, visibility, author, author_label, created_at, updated_at)
            values (${ben}, 'Vendors', '', ${await seal('Acme, Globex', 'company')}, 'company', 'agent', 'Assistant', ${created.toISOString()}::timestamp, ${created.toISOString()}::timestamp) returning id`,
      )
      const [p] = await db.getDb().execute<{ id: string }>(
        (await import('drizzle-orm'))
          .sql`insert into text_file (user_id, title, body_text, body_text_encrypted, visibility)
            values (${ben}, 'Diary', '', ${await seal('private words', 'person')}, 'private') returning id`,
      )
      await db
        .getDb()
        .execute(
          (await import('drizzle-orm'))
            .sql`insert into thought_text_file (user_id, thought_id, text_file_id) values (${ben}, ${thoughtId}, ${s!.id})`,
        )
      return { sharedOld: s!.id, privateOld: p!.id, thoughtId }
    })
    const { copyTextFilesToDriveFor } = await import('./drive-backfill')
    expect(await as(ben, () => copyTextFilesToDriveFor(ben))).toEqual({ copied: 2 })
    expect(await as(ben, () => copyTextFilesToDriveFor(ben))).toEqual({ copied: 0 })

    // The old id still resolves to its copy (tools and links already sent out keep working).
    const vendors = (await as(ben, () => svc.getTextFile(ben, sharedOld)))!
    expect(vendors).toMatchObject({
      title: 'Vendors',
      body: 'Acme, Globex',
      author: 'agent',
      authorLabel: 'Assistant',
      visibility: 'company',
      createdAt: created.toISOString(),
    })
    expect(vendors.id).not.toBe(sharedOld)
    expect(
      (await as(ben, () => svc.listTextFilesForThought(ben, thoughtId))).map((f) => f.id),
    ).toEqual([vendors.id])
    expect(await as(ana, () => svc.getTextFile(ana, sharedOld))).toMatchObject({
      body: 'Acme, Globex',
      editable: false,
    })

    const diary = (await as(ben, () => svc.getTextFile(ben, privateOld)))!
    expect(diary).toMatchObject({ body: 'private words', visibility: 'private' })
    expect(await as(ana, () => svc.getTextFile(ana, privateOld))).toBeNull()
    const drive = await driveMod.driveService()
    await expect(drive.readText(user(ana), diary.id)).rejects.toMatchObject({ code: 'not_found' })
    expect((await drive.readText(user(ben), diary.id)).file.name).toBe('Diary.md')
  })

  it('deleting everything in Memory forgets the documents and moves their Drive files to the trash', async () => {
    const doc = await as(ana, () =>
      svc.createTextFile(ana, { title: 'Scratch', body: 'to be wiped' }),
    )
    const { deleteAllMemoriesForUser } = await import('$lib/server/memory/delete-all-memories')
    const result = await as(ana, () => deleteAllMemoriesForUser(ana))
    expect(result.notesDeleted).toBeGreaterThanOrEqual(1)
    expect(await as(ana, () => svc.listTextFiles(ana, { scope: 'mine' }))).toEqual([])
    const drive = await driveMod.driveService()
    expect((await drive.trash(user(ana))).map((i) => i.id)).toContain(doc.id)
  })
})
