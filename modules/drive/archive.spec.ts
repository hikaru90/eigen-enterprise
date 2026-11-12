import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, MESSAGES_SYSTEM_OWNER, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

/**
 * Archive (contribute round 3, W4): a state on files and folders, not a magic
 * folder. Archived items leave the normal views but stay where they are,
 * openable, searchable (marked) and listed in the Archived view, grouped by
 * the folder they are in. Whoever can edit an item can archive it.
 */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice: Actor = { kind: 'user', userId: 'alice' }
const bob: Actor = { kind: 'user', userId: 'bob' }
const stranger: Actor = { kind: 'user', userId: 'nobody' }
const agent: Actor = { kind: 'agent', id: 'agent:1' }
const messages: Actor = { kind: 'agent', id: MESSAGES_SYSTEM_OWNER }
const text = (s: string) => new TextEncoder().encode(s)
const DAY = 86_400_000

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-archive-'))
  dirs.push(dir)
  const store = memoryDriveStore()
  const access = memoryDriveAccess({
    users: {
      owner: { role: 'owner', name: 'Olivia Owner' },
      alice: { role: 'member', name: 'Alice Archer' },
      bob: { role: 'member', name: 'Bob Baker' },
    },
  })
  const clock = { t: Date.parse('2026-11-12T10:00:00Z') }
  const drive = createDriveService({
    store,
    blobs: diskBlobStore(dir),
    access,
    maxUploadBytes: 1 << 20,
    locks: memoryEditLockStore(),
    now: () => new Date((clock.t += 1000)),
  })
  const share = (type: 'folder' | 'file', id: string, who: string, level: 'view' | 'edit') =>
    drive.setGrants(alice, type, id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: who }, level },
    ])
  return { drive, store, clock, share }
}

const names = (items: Array<{ name: string }>) => items.map((i) => i.name)

describe('drive archive: a state, not a folder', () => {
  it('archiving hides an item from its folder and My drive; it stays where it is, with who and when', async () => {
    const { drive, store } = await setup()
    const projects = await drive.createFolder(alice, null, 'Projects')
    const old = await drive.createFolder(alice, null, 'Old')
    const plan = await drive.upload(alice, projects.id, { name: 'plan.pdf', bytes: text('%PDF'), mime: 'application/pdf' })
    await drive.upload(alice, projects.id, { name: 'live.md', bytes: text('# hi'), mime: null })

    const archived = await drive.archive(alice, 'file', plan.id)
    expect(archived).toMatchObject({ id: plan.id, archivedBy: 'alice' })
    expect(archived.archivedAt).toBeInstanceOf(Date)
    await drive.archive(alice, 'folder', old.id)

    expect(names((await drive.listFolder(alice, projects.id)).items)).toEqual(['live.md'])
    expect(names((await drive.listFolder(alice, null)).items)).toEqual(['Projects'])
    // Nothing moved: the file is still in Projects.
    expect((await store.getFile(plan.id))?.folderId).toBe(projects.id)
  })

  it('an archived file still opens, reads and downloads; its page knows it is archived', async () => {
    const { drive } = await setup()
    const doc = await drive.upload(alice, null, { name: 'notes.md', bytes: text('kept'), mime: null })
    await drive.archive(alice, 'file', doc.id)
    const info = await drive.fileInfo(alice, doc.id)
    expect(info.file.archivedAt).toBeInstanceOf(Date)
    expect(info.archivedIn).toBeNull()
    expect((await drive.readText(alice, doc.id)).content).toBe('kept')
    expect(new TextDecoder().decode((await drive.readFile(alice, doc.id)).bytes)).toBe('kept')
  })

  it('a file inside an archived folder knows the folder it is archived with', async () => {
    const { drive } = await setup()
    const y2024 = await drive.createFolder(alice, null, '2024')
    const q1 = await drive.createFolder(alice, y2024.id, 'Q1')
    const doc = await drive.upload(alice, q1.id, { name: 'report.md', bytes: text('r'), mime: null })
    await drive.archive(alice, 'folder', y2024.id)
    const info = await drive.fileInfo(alice, doc.id)
    expect(info.file.archivedAt).toBeNull()
    expect(info.archivedIn).toEqual({ id: y2024.id, name: '2024' })
    // Opening the archived folder shows what is inside it.
    const inside = await drive.listFolder(alice, y2024.id)
    expect(inside.folder?.archivedAt).toBeInstanceOf(Date)
    expect(names(inside.items)).toEqual(['Q1'])
    expect((await drive.listFolder(alice, q1.id)).archivedIn).toEqual({ id: y2024.id, name: '2024' })
  })

  it('search still finds archived items (and what is inside archived folders), marked', async () => {
    const { drive } = await setup()
    const y2024 = await drive.createFolder(alice, null, '2024 budget')
    await drive.upload(alice, y2024.id, { name: 'budget-q1.csv', bytes: text('a'), mime: null })
    const old = await drive.upload(alice, null, { name: 'budget-old.csv', bytes: text('a'), mime: null })
    await drive.upload(alice, null, { name: 'budget-now.csv', bytes: text('a'), mime: null })
    await drive.archive(alice, 'folder', y2024.id)
    await drive.archive(alice, 'file', old.id)
    const found = await drive.search(alice, 'budget')
    expect(found.map((i) => [i.name, i.inArchive])).toEqual([
      ['2024 budget', true],
      ['budget-now.csv', false],
      ['budget-old.csv', true],
      ['budget-q1.csv', true],
    ])
  })

  it('whoever can edit archives and unarchives; a viewer may not; a stranger does not learn it exists', async () => {
    const { drive, share } = await setup()
    const doc = await drive.upload(alice, null, { name: 'shared.md', bytes: text('s'), mime: null })
    await share('file', doc.id, 'bob', 'view')
    await expect(drive.archive(bob, 'file', doc.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(drive.archive(stranger, 'file', doc.id)).rejects.toMatchObject({ code: 'not_found' })
    await share('file', doc.id, 'bob', 'edit')
    expect(await drive.archive(bob, 'file', doc.id)).toMatchObject({ archivedBy: 'bob' })
    await share('file', doc.id, 'bob', 'view')
    await expect(drive.unarchive(bob, 'file', doc.id)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await drive.unarchive(alice, 'file', doc.id)).item.archivedAt).toBeNull()
  })

  it('the agent archives with admin rights; it is recorded as the one who did', async () => {
    const { drive } = await setup()
    const doc = await drive.upload(alice, null, { name: 'a.md', bytes: text('a'), mime: null })
    expect(await drive.archive(agent, 'file', doc.id)).toMatchObject({ archivedBy: 'agent:1' })
  })

  it('archiving twice, unarchiving what is not archived and archiving from the trash are refused plainly', async () => {
    const { drive } = await setup()
    const doc = await drive.upload(alice, null, { name: 'a.md', bytes: text('a'), mime: null })
    await expect(drive.unarchive(alice, 'file', doc.id)).rejects.toMatchObject({ code: 'invalid', message: '“a.md” is not archived.' })
    await drive.archive(alice, 'file', doc.id)
    await expect(drive.archive(alice, 'file', doc.id)).rejects.toMatchObject({ code: 'invalid', message: '“a.md” is already archived.' })
    const trashed = await drive.upload(alice, null, { name: 't.md', bytes: text('t'), mime: null })
    await drive.moveToTrash(alice, 'file', trashed.id)
    await expect(drive.archive(alice, 'file', trashed.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('unarchive puts it back in the normal view; inside a still-archived folder it says so', async () => {
    const { drive } = await setup()
    const y2024 = await drive.createFolder(alice, null, '2024')
    const doc = await drive.upload(alice, y2024.id, { name: 'r.md', bytes: text('r'), mime: null })
    await drive.archive(alice, 'file', doc.id)
    await drive.archive(alice, 'folder', y2024.id)
    const back = await drive.unarchive(alice, 'file', doc.id)
    expect(back.stillIn).toEqual({ id: y2024.id, name: '2024' })
    const folderBack = await drive.unarchive(alice, 'folder', y2024.id)
    expect(folderBack.stillIn).toBeNull()
    expect(names((await drive.listFolder(alice, null)).items)).toEqual(['2024'])
    expect(names((await drive.listFolder(alice, y2024.id)).items)).toEqual(['r.md'])
  })

  it('a trashed archived item goes to the trash as usual and comes back archived', async () => {
    const { drive } = await setup()
    const doc = await drive.upload(alice, null, { name: 'a.md', bytes: text('a'), mime: null })
    await drive.archive(alice, 'file', doc.id)
    await drive.moveToTrash(alice, 'file', doc.id)
    expect(await drive.archived(alice)).toEqual([])
    expect(names(await drive.trash(alice))).toEqual(['a.md'])
    await drive.restore(alice, 'file', doc.id)
    expect(names((await drive.archived(alice)).flatMap((g) => g.items))).toEqual(['a.md'])
  })

  it('Shared with me leaves out what was archived', async () => {
    const { drive, share } = await setup()
    const folder = await drive.createFolder(alice, null, 'Team')
    await drive.upload(alice, folder.id, { name: 'inside.md', bytes: text('i'), mime: null })
    const loose = await drive.upload(alice, null, { name: 'loose.md', bytes: text('l'), mime: null })
    await share('folder', folder.id, 'bob', 'view')
    await share('file', loose.id, 'bob', 'view')
    expect(names(await drive.sharedWithMe(bob))).toEqual(['Team', 'loose.md'])
    await drive.archive(alice, 'folder', folder.id)
    // The folder's contents do not surface on their own once it is archived.
    expect(names(await drive.sharedWithMe(bob))).toEqual(['loose.md'])
  })
})

describe('drive archive: the Archived view', () => {
  it('lists archived items you can open, grouped by the folder they are in, newest first, with who archived them', async () => {
    const { drive, share } = await setup()
    const projects = await drive.createFolder(alice, null, 'Projects')
    const y2023 = await drive.createFolder(alice, projects.id, '2023')
    const a = await drive.upload(alice, y2023.id, { name: 'a.md', bytes: text('a'), mime: null })
    const b = await drive.upload(alice, y2023.id, { name: 'b.md', bytes: text('b'), mime: null })
    const top = await drive.upload(alice, null, { name: 'top.md', bytes: text('t'), mime: null })
    const bobs = await drive.upload(bob, null, { name: 'bobs.md', bytes: text('x'), mime: null })
    await drive.archive(alice, 'file', a.id)
    await drive.archive(alice, 'file', top.id)
    await drive.archive(alice, 'file', b.id)
    await drive.archive(bob, 'file', bobs.id)

    const groups = await drive.archived(alice)
    expect(groups.map((g) => ({ root: g.root.label, path: g.path.map((c) => c.name), items: names(g.items) }))).toEqual([
      { root: 'My drive', path: [], items: ['top.md'] },
      { root: 'My drive', path: ['Projects', '2023'], items: ['b.md', 'a.md'] },
    ])
    expect(groups[1]!.folder).toEqual({ id: y2023.id, name: '2023' })
    expect(groups[1]!.items[0]).toMatchObject({ archivedBy: 'alice', archivedByName: 'Alice Archer', canEdit: true })

    // Bob sees his own, and Alice's once she shares it with him.
    expect(names((await drive.archived(bob)).flatMap((g) => g.items))).toEqual(['bobs.md'])
    await share('file', top.id, 'bob', 'view')
    const bobGroups = await drive.archived(bob)
    expect(bobGroups.map((g) => [g.root.label, names(g.items)])).toEqual([
      ['My drive', ['bobs.md']],
      ['Shared with me', ['top.md']],
    ])
    expect(bobGroups[1]!.items[0]).toMatchObject({ canEdit: false })
  })
})

describe('drive archive: candidates for "suggest what to archive"', () => {
  it('files you can edit, unchanged since the cut-off, oldest first, not already archived, trashed or Messages attachments', async () => {
    const { drive, clock, share } = await setup()
    const start = clock.t
    const old = await drive.createFolder(alice, null, 'Old')
    const draft = await drive.upload(alice, old.id, { name: 'draft-v1.md', bytes: text('1'), mime: null })
    const notes = await drive.upload(alice, null, { name: 'notes.md', bytes: text('n'), mime: null })
    const gone = await drive.upload(alice, null, { name: 'gone.md', bytes: text('g'), mime: null })
    const done = await drive.upload(alice, null, { name: 'done.md', bytes: text('d'), mime: null })
    await drive.upload(bob, null, { name: 'bob-only.md', bytes: text('b'), mime: null })
    const viewOnly = await drive.upload(alice, null, { name: 'view-only.md', bytes: text('v'), mime: null })
    const inbox = await drive.createFolder(messages, null, 'Messages')
    const convo = await drive.createFolder(messages, inbox.id, 'general')
    await drive.upload(messages, convo.id, { name: 'attachment.png', bytes: text('p'), mime: 'image/png' })
    await drive.moveToTrash(alice, 'file', gone.id)
    await drive.archive(alice, 'file', done.id)
    clock.t = start + 200 * DAY
    await drive.upload(alice, old.id, { name: 'fresh.md', bytes: text('f'), mime: null })

    const cutoff = new Date(start + 100 * DAY)
    const forAlice = await drive.archiveCandidates(alice, { changedBefore: cutoff, limit: 10 })
    expect(forAlice.candidates.map((c) => c.file.name)).toEqual(['draft-v1.md', 'notes.md', 'view-only.md'])
    expect(forAlice.more).toBe(false)
    const first = forAlice.candidates[0]!
    expect(first).toMatchObject({ root: { label: 'My drive' }, path: [{ id: old.id, name: 'Old' }] })
    expect(first.createdAt).toBeInstanceOf(Date)
    // Folder context: how many files sit beside it and when that folder last changed.
    expect(first.folder).toMatchObject({ files: 2 })
    expect(first.folder.newestChange.getTime()).toBeGreaterThan(cutoff.getTime())
    expect(draft.id).toBe(first.file.id)

    await share('file', viewOnly.id, 'bob', 'view')
    await share('file', notes.id, 'bob', 'edit')
    const forBob = await drive.archiveCandidates(bob, { changedBefore: cutoff, limit: 10 })
    expect(forBob.candidates.map((c) => c.file.name)).toEqual(['notes.md', 'bob-only.md'])

    // The agent (admin rights) considers everyone's files, but never conversation attachments.
    const forAgent = await drive.archiveCandidates(agent, { changedBefore: cutoff, limit: 10 })
    expect(forAgent.candidates.map((c) => c.file.name)).toEqual(['draft-v1.md', 'notes.md', 'bob-only.md', 'view-only.md'])

    const limited = await drive.archiveCandidates(alice, { changedBefore: cutoff, limit: 2 })
    expect(limited.candidates.map((c) => c.file.name)).toEqual(['draft-v1.md', 'notes.md'])
    expect(limited.more).toBe(true)
  })

  it('a file inside an archived folder is not a candidate (it is archived with the folder)', async () => {
    const { drive, clock } = await setup()
    const start = clock.t
    const folder = await drive.createFolder(alice, null, 'Done')
    await drive.upload(alice, folder.id, { name: 'x.md', bytes: text('x'), mime: null })
    await drive.archive(alice, 'folder', folder.id)
    clock.t = start + 400 * DAY
    expect((await drive.archiveCandidates(alice, { changedBefore: new Date(start + 300 * DAY), limit: 10 })).candidates).toEqual([])
  })
})
