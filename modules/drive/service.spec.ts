import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, DriveError, resolveMaxUploadBytes, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const owner: Actor = { kind: 'user', userId: 'owner' }
const alice: Actor = { kind: 'user', userId: 'alice' }
const bob: Actor = { kind: 'user', userId: 'bob' }
const carol: Actor = { kind: 'user', userId: 'carol' }
const stranger: Actor = { kind: 'user', userId: 'nobody' }
const agent: Actor = { kind: 'agent', id: 'agent:1' }
const text = (s: string) => new TextEncoder().encode(s)

async function setup(maxUploadBytes = 1024) {
  const dir = await mkdtemp(join(tmpdir(), 'drive-svc-'))
  dirs.push(dir)
  const store = memoryDriveStore()
  const blobs = diskBlobStore(dir)
  const access = memoryDriveAccess({
    users: {
      owner: { role: 'owner' },
      alice: { role: 'member' },
      bob: { role: 'member', groups: ['design'] },
      carol: { role: 'member' },
    },
    groups: { design: 'Design' },
  })
  let t = Date.parse('2026-11-03T10:00:00Z')
  const drive = createDriveService({ store, blobs, access, maxUploadBytes, now: () => new Date((t += 1000)) })
  return { drive, store, blobs, access }
}

/** Shares as alice, keeping her own manage grant (setGrants replaces the whole set, like the contract). */
function share(drive: Awaited<ReturnType<typeof setup>>['drive'], type: 'folder' | 'file', id: string, entries: Parameters<Awaited<ReturnType<typeof setup>>['drive']['setGrants']>[3]) {
  return drive.setGrants(alice, type, id, [{ subject: { kind: 'user', userId: 'alice' }, level: 'manage' }, ...entries])
}

async function expectCode(p: Promise<unknown>, code: DriveError['code']) {
  await expect(p).rejects.toMatchObject({ code })
}

describe('drive: folders, files and the creator', () => {
  it('a member creates folders and files in their own drive and sees only their own top level', async () => {
    const { drive } = await setup()
    const projects = await drive.createFolder(alice, null, 'Projects')
    await drive.upload(alice, projects.id, { name: 'plan.pdf', bytes: text('%PDF'), mime: 'application/pdf' })
    await drive.createFolder(bob, null, 'Bob stuff')
    expect((await drive.listFolder(alice, null)).items.map((i) => i.name)).toEqual(['Projects'])
    const inside = await drive.listFolder(alice, projects.id)
    expect(inside.items.map((i) => i.name)).toEqual(['plan.pdf'])
    expect(inside.path).toEqual([{ id: projects.id, name: 'Projects' }])
    expect(inside).toMatchObject({ canEdit: true, canManage: true })
  })

  it('rejects empty names, slashes and files over the size limit with plain errors', async () => {
    const { drive } = await setup(10)
    await expectCode(drive.createFolder(alice, null, '  '), 'invalid')
    await expectCode(drive.createFolder(alice, null, 'a/b'), 'invalid')
    await expect(drive.upload(alice, null, { name: 'big.bin', bytes: new Uint8Array(11), mime: null })).rejects.toThrow(
      /“big.bin” is 11 B; files can be at most 10 B/,
    )
  })

  it('New → Document / Table creates empty .md / .csv files with a first revision', async () => {
    const { drive } = await setup()
    const doc = await drive.createDocument(alice, null, 'md', 'notes')
    const table = await drive.createDocument(alice, null, 'csv')
    expect(doc).toMatchObject({ name: 'notes.md', size: 0, mime: 'text/markdown' })
    expect(table).toMatchObject({ name: 'Untitled table.csv', mime: 'text/csv' })
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(1)
  })

  it('search finds by name only what the actor can view', async () => {
    const { drive } = await setup()
    await drive.createDocument(alice, null, 'md', 'Roadmap')
    await drive.createDocument(bob, null, 'md', 'roadmap bob')
    expect((await drive.search(alice, 'ROAD')).map((i) => i.name)).toEqual(['Roadmap.md'])
    expect((await drive.search(owner, 'road')).map((i) => i.name).sort()).toEqual(['Roadmap.md', 'roadmap bob.md'].sort())
  })

  it('a folder never moves into itself or below itself', async () => {
    const { drive } = await setup()
    const a = await drive.createFolder(alice, null, 'A')
    const b = await drive.createFolder(alice, a.id, 'B')
    await expectCode(drive.move(alice, 'folder', a.id, b.id), 'invalid')
    await expectCode(drive.move(alice, 'folder', a.id, a.id), 'invalid')
    expect(await drive.move(alice, 'folder', b.id, null)).toMatchObject({ parentId: null })
  })

  it('storage counts each distinct blob once (dedupe)', async () => {
    const { drive } = await setup()
    await drive.upload(alice, null, { name: 'a.txt', bytes: text('same bytes'), mime: null })
    await drive.upload(bob, null, { name: 'b.txt', bytes: text('same bytes'), mime: null })
    expect(await drive.storageBytes()).toBe(10)
  })
})

describe('drive: access is checked on every read and write (fail closed)', () => {
  it('without a grant another member can neither see, read nor change anything', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    const file = await drive.createDocument(alice, f.id, 'md', 'notes')
    await expectCode(drive.listFolder(bob, f.id), 'not_found')
    await expectCode(drive.readFile(bob, file.id), 'not_found')
    await expectCode(drive.readText(bob, file.id), 'not_found')
    await expectCode(drive.fileInfo(bob, file.id), 'not_found')
    await expectCode(drive.listRevisions(bob, file.id), 'not_found')
    await expectCode(drive.rename(bob, 'file', file.id, 'x.md'), 'not_found')
    await expectCode(drive.writeText(bob, file.id, 'x'), 'not_found')
    await expectCode(drive.moveToTrash(bob, 'folder', f.id), 'not_found')
    await expectCode(drive.getGrants(bob, 'folder', f.id), 'not_found')
    await expectCode(drive.createFolder(bob, f.id, 'inside'), 'not_found')
    await expectCode(drive.upload(bob, f.id, { name: 'x.txt', bytes: text('x'), mime: null }), 'not_found')
    await expectCode(drive.listFolder(stranger, f.id), 'not_found')
    expect(await drive.sharedWithMe(bob)).toEqual([])
    expect(await drive.search(bob, 'notes')).toEqual([])
  })

  it('view on a folder inherits to its files: open and read, but not edit, trash, move or share', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    const file = await drive.createDocument(alice, f.id, 'md', 'notes')
    await share(drive, 'folder', f.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'view' }])
    expect((await drive.sharedWithMe(bob)).map((i) => i.name)).toEqual(['Projects'])
    expect((await drive.listFolder(bob, f.id)).items.map((i) => i.name)).toEqual(['notes.md'])
    expect(await drive.fileInfo(bob, file.id)).toMatchObject({ canEdit: false, canManage: false })
    expect((await drive.readText(bob, file.id)).content).toBe('')
    await expectCode(drive.rename(bob, 'file', file.id, 'x.md'), 'forbidden')
    await expectCode(drive.writeText(bob, file.id, 'x'), 'forbidden')
    await expectCode(drive.moveToTrash(bob, 'file', file.id), 'forbidden')
    await expectCode(drive.move(bob, 'file', file.id, null), 'forbidden')
    await expectCode(drive.createDocument(bob, f.id, 'md'), 'forbidden')
    await expectCode(drive.setGrants(bob, 'folder', f.id, []), 'forbidden')
    await expectCode(drive.listFolder(carol, f.id), 'not_found')
  })

  it('edit lets the person rename and write; manage lets them share; group and company grants count', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    const file = await drive.createDocument(alice, f.id, 'md', 'notes')
    await share(drive, 'folder', f.id, [
      { subject: { kind: 'group', groupId: 'design' }, level: 'edit' },
      { subject: { kind: 'company' }, level: 'view' },
    ])
    expect(await drive.rename(bob, 'file', file.id, 'renamed.md')).toMatchObject({ name: 'renamed.md' })
    await drive.writeText(bob, file.id, '# by bob')
    await expectCode(drive.writeText(carol, file.id, 'no'), 'forbidden')
    expect((await drive.readText(carol, file.id)).content).toBe('# by bob')
    await expectCode(drive.getGrants(bob, 'folder', f.id), 'forbidden')
    await share(drive, 'file', file.id, [{ subject: { kind: 'user', userId: 'carol' }, level: 'manage' }])
    expect(await drive.getGrants(carol, 'file', file.id)).toHaveLength(2)
  })

  it('the company owner manages everything; the creator of a folder manages what others add to it', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    await share(drive, 'folder', f.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'edit' }])
    const bobs = await drive.createDocument(bob, f.id, 'md', 'from bob')
    expect(await drive.fileInfo(alice, bobs.id)).toMatchObject({ canManage: true })
    expect(await drive.fileInfo(owner, bobs.id)).toMatchObject({ canManage: true })
    await drive.moveToTrash(owner, 'folder', f.id)
  })

  it('naming the same person twice in one share is refused', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'P')
    await expectCode(
      share(drive, 'folder', f.id, [
        { subject: { kind: 'user', userId: 'bob' }, level: 'view' },
        { subject: { kind: 'user', userId: 'bob' }, level: 'edit' },
      ]),
      'invalid',
    )
  })

  it('the agent acts with admin rights', async () => {
    const { drive } = await setup()
    const file = await drive.createDocument(alice, null, 'md', 'notes')
    const out = await drive.writeText(agent, file.id, 'agent text')
    expect(out.revision.authorId).toBe('agent:1')
  })
})

describe('drive: trash', () => {
  it('trashed items leave every list (and what is inside a trashed folder too), then come back on restore', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    const file = await drive.createDocument(alice, f.id, 'md', 'notes')
    await drive.moveToTrash(alice, 'folder', f.id)
    expect((await drive.listFolder(alice, null)).items).toEqual([])
    await expectCode(drive.readFile(alice, file.id), 'not_found')
    expect(await drive.search(alice, 'notes')).toEqual([])
    expect((await drive.trash(alice)).map((i) => i.name)).toEqual(['Projects'])
    await drive.restore(alice, 'folder', f.id)
    expect((await drive.readText(alice, file.id)).content).toBe('')
    expect(await drive.trash(alice)).toEqual([])
  })

  it('a file restored out of a trashed folder lands on the top level', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    const file = await drive.createDocument(alice, f.id, 'md', 'notes')
    await drive.moveToTrash(alice, 'file', file.id)
    await drive.moveToTrash(alice, 'folder', f.id)
    expect(await drive.restore(alice, 'file', file.id)).toMatchObject({ parentId: null })
  })

  it('delete forever needs manage and the trash; it removes revisions and unused blobs', async () => {
    const { drive, blobs } = await setup()
    const f = await drive.createFolder(alice, null, 'Projects')
    const file = await drive.createDocument(alice, f.id, 'md', 'notes')
    const { revision } = await drive.writeText(alice, file.id, 'only here')
    await share(drive, 'folder', f.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'edit' }])
    await expectCode(drive.deleteForever(alice, 'folder', f.id), 'invalid')
    await drive.moveToTrash(bob, 'folder', f.id)
    expect((await drive.trash(bob)).map((i) => i.name)).toEqual(['Projects'])
    await expectCode(drive.deleteForever(bob, 'folder', f.id), 'forbidden')
    await drive.deleteForever(alice, 'folder', f.id)
    expect(await blobs.has(revision.sha256)).toBe(false)
    expect(await drive.trash(alice)).toEqual([])
    await expectCode(drive.restore(alice, 'folder', f.id), 'not_found')
  })

  it('a blob still used by another file survives delete forever', async () => {
    const { drive, blobs } = await setup()
    const a = await drive.upload(alice, null, { name: 'a.txt', bytes: text('shared'), mime: null })
    const b = await drive.upload(alice, null, { name: 'b.txt', bytes: text('shared'), mime: null })
    await drive.moveToTrash(alice, 'file', a.id)
    await drive.deleteForever(alice, 'file', a.id)
    expect((await drive.readText(alice, b.id)).content).toBe('shared')
    expect(await blobs.has((await drive.readFile(alice, b.id)).file.sha256)).toBe(true)
  })
})

describe('drive: text revisions', () => {
  it('every write of a .md/.csv stores a revision with author and time; restore saves it again as newest', async () => {
    const { drive } = await setup()
    const f = await drive.createFolder(alice, null, 'P')
    const doc = await drive.createDocument(alice, f.id, 'csv', 'budget')
    await share(drive, 'folder', f.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'edit' }])
    const v1 = await drive.writeText(alice, doc.id, 'a,b\n1,2\n')
    await drive.writeText(bob, doc.id, 'a,b\n9,9\n')
    const revs = await drive.listRevisions(alice, doc.id)
    expect(revs.map((r) => r.authorId)).toEqual(['bob', 'alice', 'alice'])
    expect(revs[0]!.createdAt.getTime()).toBeGreaterThan(revs[1]!.createdAt.getTime())
    await drive.restoreRevision(bob, doc.id, v1.revision.id)
    expect((await drive.readText(alice, doc.id)).content).toBe('a,b\n1,2\n')
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(4)
  })

  it('write_text refuses non-revisioned files; restore refuses a revision of another file and view-only people', async () => {
    const { drive } = await setup()
    const txt = await drive.upload(alice, null, { name: 'a.txt', bytes: text('x'), mime: null })
    await expectCode(drive.writeText(alice, txt.id, 'y'), 'invalid')
    const a = await drive.createDocument(alice, null, 'md', 'a')
    const b = await drive.createDocument(alice, null, 'md', 'b')
    const [revB] = await drive.listRevisions(alice, b.id)
    await expectCode(drive.restoreRevision(alice, a.id, revB!.id), 'not_found')
    await share(drive, 'file', a.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'view' }])
    const [revA] = await drive.listRevisions(bob, a.id)
    await expectCode(drive.restoreRevision(bob, a.id, revA!.id), 'forbidden')
  })
})

describe('resolveMaxUploadBytes', () => {
  it('reads DRIVE_MAX_UPLOAD_BYTES, defaults to 100 MB and refuses nonsense', () => {
    expect(resolveMaxUploadBytes({ DRIVE_MAX_UPLOAD_BYTES: '2048' })).toBe(2048)
    expect(resolveMaxUploadBytes({})).toBe(100 * 1024 * 1024)
    expect(() => resolveMaxUploadBytes({ DRIVE_MAX_UPLOAD_BYTES: '10MB' })).toThrow(/positive whole number/)
  })
})
