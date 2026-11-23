import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
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
  const drive = createDriveService({ store, blobs, access, maxUploadBytes, locks: memoryEditLockStore(), now: () => new Date((t += 1000)) })
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
    await drive.upload(alice, projects.id, { name: 'plan.pdf', bytes: text('%PDF'), mime: 'application/pdf' }, 'fail')
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
    await expect(drive.upload(alice, null, { name: 'big.bin', bytes: new Uint8Array(11), mime: null }, 'fail')).rejects.toThrow(
      /“big.bin” is 11 B; files can be at most 10 B/,
    )
  })

  it('New → Document / Table creates empty .md / .csv files; the empty start is no revision', async () => {
    const { drive } = await setup()
    const doc = await drive.createDocument(alice, null, 'md', 'notes')
    const table = await drive.createDocument(alice, null, 'csv')
    expect(doc).toMatchObject({ name: 'notes.md', size: 0, mime: 'text/markdown' })
    expect(table).toMatchObject({ name: 'Untitled table.csv', mime: 'text/csv' })
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(0)
    await drive.writeText(alice, doc.id, '# Hi')
    expect((await drive.listRevisions(alice, doc.id)).map((r) => r.size)).toEqual([4])
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
    await drive.upload(alice, null, { name: 'a.txt', bytes: text('same bytes'), mime: null }, 'fail')
    await drive.upload(bob, null, { name: 'b.txt', bytes: text('same bytes'), mime: null }, 'fail')
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
    await expectCode(drive.upload(bob, f.id, { name: 'x.txt', bytes: text('x'), mime: null }, 'fail'), 'not_found')
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
    const a = await drive.upload(alice, null, { name: 'a.txt', bytes: text('shared'), mime: null }, 'fail')
    const b = await drive.upload(alice, null, { name: 'b.txt', bytes: text('shared'), mime: null }, 'fail')
    await drive.moveToTrash(alice, 'file', a.id)
    await drive.deleteForever(alice, 'file', a.id)
    expect((await drive.readText(alice, b.id)).content).toBe('shared')
    expect(await blobs.has((await drive.readFile(alice, b.id)).file.sha256)).toBe(true)
  })
})

describe('drive: paths name whose tree it is', () => {
  it('My drive for your own, Shared with me for someone else’s (ancestors you can’t open left out), Messages for attachments', async () => {
    const { drive } = await setup()
    const top = await drive.createFolder(alice, null, 'Alice top')
    const sub = await drive.createFolder(alice, top.id, 'Projects')
    const doc = await drive.createDocument(alice, sub.id, 'md', 'plan')
    await drive.setGrants(alice, 'folder', sub.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'edit' }])
    expect(await drive.fileInfo(alice, doc.id)).toMatchObject({ root: { label: 'My drive' }, path: [{ name: 'Alice top' }, { name: 'Projects' }] })
    const forBob = await drive.fileInfo(bob, doc.id)
    expect(forBob.root).toEqual({ label: 'Shared with me', href: '/drive/shared' })
    expect(forBob.path.map((c) => c.name)).toEqual(['Projects'])
    expect((await drive.listFolder(bob, sub.id)).root.label).toBe('Shared with me')
    const messages: Actor = { kind: 'agent', id: 'messages' }
    const root = await drive.createFolder(messages, null, 'Messages')
    const general = await drive.createFolder(messages, root.id, '#general')
    await drive.setGrants(owner, 'folder', general.id, [{ subject: { kind: 'company' }, level: 'edit' }])
    const att = await drive.upload(alice, general.id, { name: 'agenda.md', bytes: text('# A'), mime: 'text/markdown' }, 'fail')
    for (const who of [bob, owner]) {
      const info = await drive.fileInfo(who, att.id)
      expect(info.root).toEqual({ label: 'Messages', href: '/messages' })
      expect(info.path.map((c) => c.name)).toEqual(['#general'])
    }
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
    expect(revs.map((r) => r.authorId)).toEqual(['bob', 'alice'])
    expect(revs[0]!.createdAt.getTime()).toBeGreaterThan(revs[1]!.createdAt.getTime())
    await drive.restoreRevision(bob, doc.id, v1.revision.id)
    expect((await drive.readText(alice, doc.id)).content).toBe('a,b\n1,2\n')
    const after = await drive.listRevisions(alice, doc.id)
    expect(after).toHaveLength(3)
    expect(after[0]).toMatchObject({ authorId: 'bob', restoredFrom: { id: v1.revision.id, authorId: 'alice' } })
    expect(after[1]!.restoredFrom).toBeUndefined()
  })

  it('one revision per editing session: saves under one lock fold together; take-over and restore start new ones', async () => {
    const { drive } = await setup()
    const doc = await drive.createDocument(alice, null, 'md', 'notes')
    await share(drive, 'file', doc.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'edit' }])
    await drive.acquireLock(alice, doc.id, 'alice-session-1')
    await drive.writeText(alice, doc.id, 'a', 'alice-session-1')
    await drive.writeText(alice, doc.id, 'ab', 'alice-session-1')
    await drive.writeText(alice, doc.id, 'abc', 'alice-session-1')
    let revs = await drive.listRevisions(alice, doc.id)
    expect(revs.map((r) => [r.authorId, r.size])).toEqual([['alice', 3]])
    // Bob takes over: a new revision, then his saves fold into it.
    await drive.acquireLock(bob, doc.id, 'bob-session-1', { takeover: true })
    await drive.writeText(bob, doc.id, 'abcd', 'bob-session-1')
    await drive.writeText(bob, doc.id, 'abcde', 'bob-session-1')
    revs = await drive.listRevisions(alice, doc.id)
    expect(revs.map((r) => [r.authorId, r.size])).toEqual([['bob', 5], ['alice', 3]])
    // A restore is its own checkpoint; the next save starts a new revision.
    await drive.restoreRevision(bob, doc.id, revs[1]!.id, 'bob-session-1')
    await drive.writeText(bob, doc.id, 'abc!', 'bob-session-1')
    revs = await drive.listRevisions(alice, doc.id)
    expect(revs.map((r) => [r.authorId, r.size, r.restoredFrom?.authorId ?? null])).toEqual([
      ['bob', 4, null],
      ['bob', 3, 'alice'],
      ['bob', 5, null],
      ['alice', 3, null],
    ])
    // Letting go of the lock ends the session: the next save is a new revision.
    await drive.releaseLock(bob, doc.id, 'bob-session-1')
    await drive.writeText(bob, doc.id, 'abc!?', 'bob-session-1')
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(5)
  })

  it('an empty first revision from before is not listed', async () => {
    const { drive, store } = await setup()
    const doc = await drive.createDocument(alice, null, 'md', 'old')
    await store.insertRevision({ id: 'r0', fileId: doc.id, sha256: 'e3b0', size: 0, authorId: 'alice', createdAt: new Date('2026-01-01') })
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(0)
    await drive.writeText(alice, doc.id, 'x')
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(1)
  })

  it('write_text refuses non-revisioned files; restore refuses a revision of another file and view-only people', async () => {
    const { drive } = await setup()
    const txt = await drive.upload(alice, null, { name: 'a.txt', bytes: text('x'), mime: null }, 'fail')
    await expectCode(drive.writeText(alice, txt.id, 'y'), 'invalid')
    const a = await drive.createDocument(alice, null, 'md', 'a')
    const b = await drive.createDocument(alice, null, 'md', 'b')
    await drive.writeText(alice, a.id, 'a1')
    await drive.writeText(alice, b.id, 'b1')
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

describe('drive service: when a file is from (Contribute 0c945439)', () => {
  it('dates a PDF by the creation date it records, and anything else by when it was uploaded', async () => {
    const { drive, store } = await setup()
    const letter = await drive.upload(alice, null, { name: 'letter.pdf', bytes: text('%PDF-1.4\n<< /CreationDate (D:19870512093000Z) >>\n%%EOF'), mime: 'application/pdf' }, 'fail')
    expect(letter.dated).toEqual({ at: new Date('1987-05-12T09:30:00.000Z'), kind: 'created' })
    expect(await store.getFile(letter.id)).toMatchObject({ contentDate: new Date('1987-05-12T09:30:00.000Z'), contentDateKind: 'created' })
    const note = await drive.upload(alice, null, { name: 'note.txt', bytes: text('hello'), mime: null }, 'fail')
    const stored = await store.getFile(note.id)
    expect(stored).toMatchObject({ contentDate: null, contentDateKind: null })
    expect(note.dated).toEqual({ at: stored!.createdAt, kind: 'uploaded' })
    // Listings carry the same date.
    const listed = (await drive.listFolder(alice, null)).items.find((i) => i.id === letter.id)
    expect(listed?.dated).toEqual({ at: new Date('1987-05-12T09:30:00.000Z'), kind: 'created' })
  })
})

describe('drive service: reading a file by its path inside a folder (rendered HTML)', () => {
  async function site() {
    const s = await setup()
    const root = await s.drive.createFolder(alice, null, 'Site')
    const css = await s.drive.createFolder(alice, root.id, 'css')
    await s.drive.upload(alice, root.id, { name: 'index.html', bytes: text('<h1>Hi</h1>'), mime: 'text/html' }, 'fail')
    await s.drive.upload(alice, css.id, { name: 'site.css', bytes: text('h1{color:red}'), mime: 'text/css' }, 'fail')
    return { ...s, root, css }
  }

  it('walks folder names down to the file and returns its bytes', async () => {
    const { drive, root } = await site()
    const out = await drive.readAtPath(alice, root.id, ['css', 'site.css'])
    expect(out.file.name).toBe('site.css')
    expect(new TextDecoder().decode(out.bytes)).toBe('h1{color:red}')
  })

  it('refuses dot segments and empty names, so a path cannot climb out of its folder', async () => {
    const { drive, root } = await site()
    await expectCode(drive.readAtPath(alice, root.id, ['..', 'index.html']), 'invalid')
    await expectCode(drive.readAtPath(alice, root.id, ['.', 'index.html']), 'invalid')
    await expectCode(drive.readAtPath(alice, root.id, ['', 'index.html']), 'invalid')
    await expectCode(drive.readAtPath(alice, root.id, []), 'not_found')
  })

  it('says not found for a missing name, a folder where a file is wanted, and trashed files', async () => {
    const { drive, root } = await site()
    await expectCode(drive.readAtPath(alice, root.id, ['missing.js']), 'not_found')
    await expectCode(drive.readAtPath(alice, root.id, ['css']), 'not_found')
    const page = (await drive.listFolder(alice, root.id)).items.find((i) => i.name === 'index.html')!
    await drive.moveToTrash(alice, 'file', page.id)
    await expectCode(drive.readAtPath(alice, root.id, ['index.html']), 'not_found')
  })

  it('fails loud when two files share the name the path asks for', async () => {
    const { drive, root } = await site()
    await drive.upload(alice, root.id, { name: 'dup.js', bytes: text('1'), mime: null }, 'fail')
    // An upload can't add a second “dup.js” any more (it asks); a rename still can.
    const other = await drive.upload(alice, root.id, { name: 'other.js', bytes: text('2'), mime: null }, 'fail')
    await drive.rename(alice, 'file', other.id, 'dup.js')
    await expect(drive.readAtPath(alice, root.id, ['dup.js'])).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/2 items named "dup.js"/) })
  })

  it('needs view access, like opening the file', async () => {
    const { drive, root } = await site()
    await expectCode(drive.readAtPath(bob, root.id, ['index.html']), 'not_found')
  })
})

describe('drive: web app folders (plan/phase-drive-app-preview.md)', () => {
  async function app(pkg: string, extra: Array<[string, string]> = []) {
    const s = await setup(1 << 20)
    const root = await s.drive.createFolder(alice, null, 'shop')
    await s.drive.upload(alice, root.id, { name: 'package.json', bytes: text(pkg), mime: 'application/json' }, 'fail')
    for (const [name, body] of extra) await s.drive.upload(alice, root.id, { name, bytes: text(body), mime: null }, 'fail')
    return { ...s, root }
  }

  it('a top-level package.json with a dev script is a web app; the lockfile next to it is named', async () => {
    const { drive, root } = await app('{"scripts":{"dev":"vite","start":"node server.js"}}', [['pnpm-lock.yaml', 'lockfileVersion: 9']])
    expect(await drive.webApp(alice, root.id)).toMatchObject({ folder: { id: root.id, name: 'shop' }, webApp: { script: 'dev', lockfile: 'pnpm-lock.yaml' } })
  })

  it('falls back to start, and says lockfile null when there is none (Run will fail, not hide)', async () => {
    const { drive, root } = await app('{"scripts":{"start":"node server.js"}}')
    expect((await drive.webApp(alice, root.id)).webApp).toEqual({ script: 'start', lockfile: null })
  })

  it('no package.json, a nested one only, a trashed one, or invalid JSON: not a web app (no crash)', async () => {
    const s = await setup(1 << 20)
    const root = await s.drive.createFolder(alice, null, 'repo')
    const sub = await s.drive.createFolder(alice, root.id, 'web')
    await s.drive.upload(alice, sub.id, { name: 'package.json', bytes: text('{"scripts":{"dev":"vite"}}'), mime: null }, 'fail')
    expect((await s.drive.webApp(alice, root.id)).webApp).toBeNull()
    const trashed = await s.drive.upload(alice, root.id, { name: 'package.json', bytes: text('{"scripts":{"dev":"vite"}}'), mime: null }, 'fail')
    await s.drive.moveToTrash(alice, 'file', trashed.id)
    expect((await s.drive.webApp(alice, root.id)).webApp).toBeNull()
    const broken = await app('{"scripts": {"dev": "vite"')
    expect((await broken.drive.webApp(alice, broken.root.id)).webApp).toBeNull()
  })

  it('two package.json files in the folder fail loud; it needs view access', async () => {
    const { drive, root } = await app('{"scripts":{"dev":"vite"}}', [['package (copy).json', '{}']])
    const copy = (await drive.listFolder(alice, root.id)).items.find((i) => i.name === 'package (copy).json')!
    await drive.rename(alice, 'file', copy.id, 'package.json')
    await expect(drive.webApp(alice, root.id)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/2 items named "package.json"/) })
    await expectCode(drive.webApp(bob, root.id), 'not_found')
  })

  it('a snapshot lists every live file by its relative path, without node_modules, .git or the trash', async () => {
    const { drive, root } = await app('{"scripts":{"dev":"vite"}}', [['package-lock.json', '{}']])
    const src = await drive.createFolder(alice, root.id, 'src')
    await drive.upload(alice, src.id, { name: 'main.ts', bytes: text('1'), mime: null }, 'fail')
    const lib = await drive.createFolder(alice, src.id, 'lib')
    await drive.upload(alice, lib.id, { name: 'a.ts', bytes: text('22'), mime: null }, 'fail')
    const nm = await drive.createFolder(alice, root.id, 'node_modules')
    await drive.upload(alice, nm.id, { name: 'vite.js', bytes: text('x'), mime: null }, 'fail')
    const nested = await drive.createFolder(alice, src.id, 'node_modules')
    await drive.upload(alice, nested.id, { name: 'x.js', bytes: text('x'), mime: null }, 'fail')
    const git = await drive.createFolder(alice, root.id, '.git')
    await drive.upload(alice, git.id, { name: 'HEAD', bytes: text('ref'), mime: null }, 'fail')
    const gone = await drive.upload(alice, src.id, { name: 'old.ts', bytes: text('old'), mime: null }, 'fail')
    await drive.moveToTrash(alice, 'file', gone.id)
    const archived = await drive.upload(alice, src.id, { name: 'kept.ts', bytes: text('k'), mime: null }, 'fail')
    await drive.archive(alice, 'file', archived.id)
    const snap = await drive.snapshotFiles(alice, root.id)
    expect(snap.folder.name).toBe('shop')
    expect(snap.files.map((f) => f.path)).toEqual(['package-lock.json', 'package.json', 'src/kept.ts', 'src/main.ts', 'src/lib/a.ts'])
    expect(snap.bytes).toBe(snap.files.reduce((n, f) => n + f.size, 0))
    expect(new TextDecoder().decode(await snap.files.find((f) => f.path === 'src/lib/a.ts')!.read())).toBe('22')
  })

  it('two items with one name at a path fail loud (a file and a folder count too)', async () => {
    const { drive, root } = await app('{}')
    const src = await drive.createFolder(alice, root.id, 'src')
    await drive.upload(alice, src.id, { name: 'main.ts', bytes: text('1'), mime: null }, 'fail')
    await drive.createFolder(alice, src.id, 'main.ts')
    await expect(drive.snapshotFiles(alice, root.id)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/2 items named "main.ts" in “shop\/src”/) })
  })

  it('fails loud over 200 MB or 20,000 files; needs view access', async () => {
    const at = new Date()
    const row = (folderId: string, name: string, size: number) => ({
      id: `f-${folderId}-${name}`,
      folderId,
      name,
      ownerId: 'alice',
      mime: 'text/plain',
      size,
      sha256: 'a'.repeat(64),
      createdAt: at,
      updatedAt: at,
      trashedAt: null,
      archivedAt: null,
      archivedBy: null,
      source: null,
      contentDate: null,
      contentDateKind: null,
    })
    const big = await app('{}')
    await big.store.insertFile(row(big.root.id, 'huge.bin', 200 * 1024 * 1024))
    await expect(big.drive.snapshotFiles(alice, big.root.id)).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/more than 200 MB/) })
    const many = await app('{}')
    for (let i = 0; i < 20_000; i++) await many.store.insertFile(row(many.root.id, `f${i}.txt`, 0))
    await expect(many.drive.snapshotFiles(alice, many.root.id)).rejects.toMatchObject({ code: 'too_large', message: expect.stringMatching(/more than 20,000 files/) })
    await expectCode(many.drive.snapshotFiles(bob, many.root.id), 'not_found')
  })
})

describe('drive: uploading a name that is already there (bug f45acdef)', () => {
  const pdf = (s: string) => text(`%PDF-${s}`)
  const contentOf = async (drive: Awaited<ReturnType<typeof setup>>['drive'], id: string) => new TextDecoder().decode((await drive.readFile(alice, id)).bytes)

  it('fail refuses with a conflict naming the existing file, and adds nothing', async () => {
    const { drive } = await setup()
    const folder = await drive.createFolder(alice, null, 'Reports')
    const first = await drive.upload(alice, folder.id, { name: 'q3.pdf', bytes: pdf('a'), mime: 'application/pdf' }, 'fail')
    expect(first.outcome).toBe('created')
    for (const p of [
      drive.upload(alice, folder.id, { name: 'q3.pdf', bytes: pdf('b'), mime: 'application/pdf' }, 'fail'),
      drive.upload(alice, folder.id, { name: 'q3.pdf', bytes: pdf('b'), mime: 'application/pdf' }, 'fail'),
    ]) {
      await expect(p).rejects.toMatchObject({ code: 'conflict', message: '“q3.pdf” already exists in Reports.', existing: { id: first.id, name: 'q3.pdf' } })
    }
    expect((await drive.listFolder(alice, folder.id)).items.map((i) => i.name)).toEqual(['q3.pdf'])
    expect(await contentOf(drive, first.id)).toBe('%PDF-a')
  })

  it('names compare exactly, as paths do: another case, a trashed file or someone else’s My drive is no clash', async () => {
    const { drive } = await setup()
    await drive.upload(alice, null, { name: 'Notes.txt', bytes: text('a'), mime: 'text/plain' }, 'fail')
    expect((await drive.upload(alice, null, { name: 'notes.txt', bytes: text('b'), mime: 'text/plain' }, 'fail')).outcome).toBe('created')
    expect((await drive.upload(bob, null, { name: 'Notes.txt', bytes: text('c'), mime: 'text/plain' }, 'fail')).outcome).toBe('created')
    await expect(drive.upload(alice, null, { name: 'Notes.txt', bytes: text('d'), mime: 'text/plain' }, 'fail')).rejects.toMatchObject({
      code: 'conflict',
      message: '“Notes.txt” already exists in My drive.',
    })
    const old = await drive.upload(alice, null, { name: 'old.txt', bytes: text('x'), mime: 'text/plain' }, 'fail')
    await drive.moveToTrash(alice, 'file', old.id)
    expect((await drive.upload(alice, null, { name: 'old.txt', bytes: text('y'), mime: 'text/plain' }, 'fail')).outcome).toBe('created')
  })

  it('an archived file still sits in its folder, so it clashes too', async () => {
    const { drive } = await setup()
    const f = await drive.upload(alice, null, { name: 'a.txt', bytes: text('a'), mime: 'text/plain' }, 'fail')
    await drive.archive(alice, 'file', f.id)
    await expect(drive.upload(alice, null, { name: 'a.txt', bytes: text('b'), mime: 'text/plain' }, 'fail')).rejects.toMatchObject({ code: 'conflict', existing: { id: f.id } })
  })

  it('keep_both names the new file “name (2).ext”, the next free number each time', async () => {
    const { drive } = await setup()
    const folder = await drive.createFolder(alice, null, 'F')
    const up = (name: string) => drive.upload(alice, folder.id, { name, bytes: text(name.slice(0, 10)), mime: 'text/plain' }, 'keep_both')
    expect(await up('notes.txt')).toMatchObject({ name: 'notes.txt', outcome: 'created' })
    expect(await up('notes.txt')).toMatchObject({ name: 'notes (2).txt', outcome: 'kept_both' })
    expect(await up('notes.txt')).toMatchObject({ name: 'notes (3).txt', outcome: 'kept_both' })
    expect(await up('notes (2).txt')).toMatchObject({ name: 'notes (4).txt', outcome: 'kept_both' })
    await up('README')
    expect(await up('README')).toMatchObject({ name: 'README (2)' })
    await up('.env')
    expect(await up('.env')).toMatchObject({ name: '.env (2)' })
    await up('a.tar.gz')
    expect(await up('a.tar.gz')).toMatchObject({ name: 'a.tar (2).gz' })
    const long = `${'x'.repeat(251)}.txt`
    await up(long)
    const kept = await up(long)
    expect(kept.name).toHaveLength(255)
    expect(kept.name.endsWith('x (2).txt')).toBe(true)
  })

  it('replace gives the existing file the upload as a new revision; the old version stays restorable', async () => {
    const { drive } = await setup()
    const folder = await drive.createFolder(alice, null, 'Pics')
    const first = await drive.upload(alice, folder.id, { name: 'logo.png', bytes: text('old'), mime: 'image/png' }, 'fail')
    const replaced = await drive.upload(alice, folder.id, { name: 'logo.png', bytes: text('newer'), mime: 'image/png' }, 'replace')
    expect(replaced).toMatchObject({ id: first.id, name: 'logo.png', outcome: 'replaced', size: 5 })
    expect((await drive.listFolder(alice, folder.id)).items.map((i) => i.name)).toEqual(['logo.png'])
    expect(await contentOf(drive, first.id)).toBe('newer')
    const revs = await drive.listRevisions(alice, first.id)
    expect(revs.map((r) => r.size)).toEqual([5, 3])
    await drive.restoreRevision(alice, first.id, revs[1]!.id)
    expect(await contentOf(drive, first.id)).toBe('old')
  })

  it('replace on a document that keeps history adds one revision to it', async () => {
    const { drive } = await setup()
    const doc = await drive.upload(alice, null, { name: 'plan.md', bytes: text('# v1'), mime: 'text/markdown' }, 'fail')
    expect(await drive.listRevisions(alice, doc.id)).toHaveLength(1)
    await drive.upload(alice, null, { name: 'plan.md', bytes: text('# v2!'), mime: 'text/markdown' }, 'replace')
    expect((await drive.listRevisions(alice, doc.id)).map((r) => r.size)).toEqual([5, 4])
    expect((await drive.readText(alice, doc.id)).content).toBe('# v2!')
  })

  it('replace with nothing to replace simply creates the file', async () => {
    const { drive } = await setup()
    expect(await drive.upload(alice, null, { name: 'new.txt', bytes: text('a'), mime: 'text/plain' }, 'replace')).toMatchObject({ name: 'new.txt', outcome: 'created' })
  })

  it('replace is refused while someone edits the file, over the size limit, and when two files already share the name', async () => {
    const { drive, store } = await setup(16)
    const doc = await drive.upload(alice, null, { name: 'plan.md', bytes: text('# v1'), mime: 'text/markdown' }, 'fail')
    await drive.acquireLock(alice, doc.id, 'alice-tab')
    await expectCode(drive.upload(alice, null, { name: 'plan.md', bytes: text('# v2'), mime: 'text/markdown' }, 'replace'), 'locked')
    await drive.upload(alice, null, { name: 'big.txt', bytes: text('x'), mime: 'text/plain' }, 'fail')
    await expectCode(drive.upload(alice, null, { name: 'big.txt', bytes: text('x'.repeat(17)), mime: 'text/plain' }, 'replace'), 'too_large')
    const a = await drive.upload(alice, null, { name: 'dup.txt', bytes: text('a'), mime: 'text/plain' }, 'fail')
    await store.insertFile({ ...(await store.getFile(a.id))!, id: 'legacy-dup' })
    await expect(drive.upload(alice, null, { name: 'dup.txt', bytes: text('b'), mime: 'text/plain' }, 'replace')).rejects.toMatchObject({
      code: 'invalid',
      message: 'There are 2 files named “dup.txt” in My drive; rename one so it is clear which to replace.',
    })
  })

  it('a viewer of the folder can’t replace a file in it', async () => {
    const { drive } = await setup()
    const folder = await drive.createFolder(alice, null, 'Shared')
    await drive.upload(alice, folder.id, { name: 'a.txt', bytes: text('a'), mime: 'text/plain' }, 'fail')
    await share(drive, 'folder', folder.id, [{ subject: { kind: 'user', userId: 'bob' }, level: 'view' }])
    await expectCode(drive.upload(bob, folder.id, { name: 'a.txt', bytes: text('b'), mime: 'text/plain' }, 'replace'), 'forbidden')
  })
})
