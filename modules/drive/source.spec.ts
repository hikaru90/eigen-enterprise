import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, type Actor } from './service'
import { createDriveSourceWriter } from './source-writer'
import { diskBlobStore, sha256Hex } from './storage'
import { memoryDriveStore } from './store'

/**
 * Read-only source folders (plan/github-drive.md §5, S2): a source plugin
 * writes copies through the system writer; in Drive they are read-only for
 * everyone (the agent included), shareable by owner/admins, visible to the
 * whole company, their own rail section, and out of archive suggestions.
 */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const owner: Actor = { kind: 'user', userId: 'owner' }
const admin: Actor = { kind: 'user', userId: 'admin' }
const alice: Actor = { kind: 'user', userId: 'alice' }
const agent: Actor = { kind: 'agent', id: 'agent:1' }
const READ_ONLY = 'This comes from GitHub and is read-only here. Change it on GitHub.'
const bytes = (s: string) => new TextEncoder().encode(s)

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-source-'))
  dirs.push(dir)
  const store = memoryDriveStore()
  const blobs = diskBlobStore(dir)
  const access = memoryDriveAccess({
    users: { owner: { role: 'owner', name: 'Olivia' }, admin: { role: 'admin', name: 'Adam' }, alice: { role: 'member', name: 'Alice' }, bob: { role: 'member', name: 'Bob' } },
  })
  let t = Date.parse('2026-11-12T10:00:00Z')
  const now = () => new Date((t += 1000))
  const drive = createDriveService({ store, blobs, access, maxUploadBytes: 1 << 20, locks: memoryEditLockStore(), now })
  const writer = createDriveSourceWriter({ store, blobs, access, now })
  return { drive, writer, store, blobs, access }
}

/** GitHub / acme / site / Overview.md, as the repos plugin would write it. */
async function seeded() {
  const s = await setup()
  const root = await s.writer.ensureRoot('repos', 'GitHub')
  const repo = await s.writer.upsertFolder('repos', 'repo:1', null, 'acme')
  const overview = await s.writer.upsertText('repos', 'repo:1/Overview.md', 'repo:1', 'Overview.md', '# acme\n')
  return { ...s, root, repo, overviewId: overview.fileId }
}

async function refused(p: Promise<unknown>, message = READ_ONLY) {
  await expect(p).rejects.toMatchObject({ code: 'forbidden', message })
}

describe('source folders: read-only in Drive', () => {
  it('the whole company can view a source; nobody can edit, the agent and the owner included', async () => {
    const { drive, root, repo, overviewId } = await seeded()
    expect((await drive.readText(alice, overviewId)).content).toBe('# acme\n')
    for (const actor of [owner, admin, alice, agent]) {
      const listed = await drive.listFolder(actor, repo)
      expect(listed.canEdit).toBe(false)
      expect(listed.items).toEqual([expect.objectContaining({ id: overviewId, canEdit: false })])
      const info = await drive.fileInfo(actor, overviewId)
      expect(info.canEdit).toBe(false)
      expect((await drive.listFolder(actor, root.folderId)).canEdit).toBe(false)
    }
    // A member doesn't manage it either; owner and admins do (for sharing).
    expect((await drive.fileInfo(alice, overviewId)).canManage).toBe(false)
    expect((await drive.fileInfo(admin, overviewId)).canManage).toBe(true)
  })

  it('every change is refused with the source’s own sentence, for people and the agent', async () => {
    const { drive, root, repo, overviewId } = await seeded()
    const mine = await drive.createFolder(alice, null, 'Mine')
    const myDoc = await drive.createDocument(alice, mine.id, 'md', 'notes')
    for (const actor of [owner, agent]) {
      await refused(drive.rename(actor, 'file', overviewId, 'Other.md'))
      await refused(drive.rename(actor, 'folder', repo, 'other'))
      await refused(drive.rename(actor, 'folder', root.folderId, 'Elsewhere'))
      await refused(drive.move(actor, 'file', overviewId, null))
      await refused(drive.moveToTrash(actor, 'folder', repo))
      await refused(drive.archive(actor, 'file', overviewId))
      await refused(drive.writeText(actor, overviewId, 'changed'))
      await refused(drive.acquireLock(actor, overviewId, 'session-1'))
      await refused(drive.upload(actor, repo, { name: 'x.png', bytes: bytes('p'), mime: 'image/png' }))
      await refused(drive.createDocument(actor, root.folderId, 'md'))
      await refused(drive.createFolder(actor, repo, 'New'))
    }
    // Moving something of one's own into a source is refused too.
    await refused(drive.move(owner, 'file', myDoc.id, repo))
    const archived = await drive.archiveMany(agent, [{ type: 'file', id: overviewId }])
    expect(archived.errors).toEqual([{ type: 'file', id: overviewId, error: READ_ONLY }])
    expect((await drive.readText(owner, overviewId)).content).toBe('# acme\n')
  })

  it('the sentence names the source by its root folder’s name', async () => {
    const { drive, writer } = await setup()
    await writer.ensureRoot('wiki', 'Team wiki')
    const page = await writer.upsertText('wiki', 'p1', null, 'Home.md', 'hi')
    await refused(drive.writeText(owner, page.fileId, 'x'), 'This comes from Team wiki and is read-only here. Change it on Team wiki.')
  })

  it('owner and admins can still share source items; members can’t', async () => {
    const { drive, repo } = await seeded()
    const grants = await drive.setGrants(admin, 'folder', repo, [{ subject: { kind: 'user', userId: 'bob' }, level: 'view' }])
    expect(grants).toEqual([expect.objectContaining({ subject: { kind: 'user', userId: 'bob' }, level: 'view' })])
    await expect(drive.setGrants(alice, 'folder', repo, [])).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('listings name the source: owner, a read-only mark, and the root is not "shared" by its company grant', async () => {
    const { drive, root, repo, overviewId } = await seeded()
    const rootView = (await drive.listFolder(admin, root.folderId)).folder!
    const repoView = (await drive.listFolder(admin, repo)).folder!
    const file = (await drive.fileInfo(admin, overviewId)).file
    const described = await drive.describeItems(admin, [rootView, repoView, file])
    expect(described[`folder:${root.folderId}`]).toEqual({ ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' })
    expect(described[`folder:${repo}`]).toEqual({ ownerName: 'GitHub', shared: false, readOnlyFrom: 'GitHub' })
    expect(described[`file:${overviewId}`]).toMatchObject({ readOnlyFrom: 'GitHub' })
    const mine = await drive.createFolder(alice, null, 'Mine')
    expect((await drive.describeItems(alice, [mine]))[`folder:${mine.id}`]).toMatchObject({ readOnlyFrom: null })
  })

  it('the path starts at the source root (its own section), and the rail lists the roots the actor can open', async () => {
    const { drive, root, repo, overviewId } = await seeded()
    const href = `/drive/folder/${root.folderId}`
    expect(await drive.listFolder(alice, root.folderId)).toMatchObject({ root: { label: 'GitHub', href }, path: [] })
    expect(await drive.fileInfo(alice, overviewId)).toMatchObject({ root: { label: 'GitHub', href }, path: [{ id: repo, name: 'acme' }] })
    expect(await drive.sourceRoots(alice)).toEqual([{ source: 'repos', folderId: root.folderId, name: 'GitHub', href }])
    // Narrowed by an admin: a member who can't open the root doesn't get the section.
    await drive.setGrants(admin, 'folder', root.folderId, [])
    expect(await drive.sourceRoots(alice)).toEqual([])
    expect(await drive.sourceRoots(admin)).toHaveLength(1)
  })

  it('sources stay out of My drive, Shared with me and archive suggestions', async () => {
    const { drive, store, overviewId } = await seeded()
    await store.updateFile(overviewId, { updatedAt: new Date('2020-01-01T00:00:00Z') })
    expect((await drive.listFolder(alice, null)).items).toEqual([])
    expect(await drive.sharedWithMe(alice)).toEqual([])
    const { candidates } = await drive.archiveCandidates(owner, { changedBefore: new Date('2026-01-01T00:00:00Z'), limit: 10 })
    expect(candidates).toEqual([])
    // Found by search, still read-only.
    expect((await drive.search(alice, 'Overview')).map((i) => [i.id, i.canEdit])).toEqual([[overviewId, false]])
  })
})

describe('source writer (the system writer, no access checks)', () => {
  it('ensureRoot makes one root with a company view grant, renames it, and is idempotent', async () => {
    const { writer, access, store } = await setup()
    const a = await writer.ensureRoot('repos', 'GitHub')
    expect(access.grants).toEqual([{ resourceType: 'folder', resourceId: a.folderId, subject: { kind: 'company' }, level: 'view' }])
    const b = await writer.ensureRoot('repos', 'GitHub')
    expect(b).toEqual(a)
    const c = await writer.ensureRoot('repos', 'Repos')
    expect(c).toEqual({ ...a, name: 'Repos' })
    expect((await store.getFolder(a.folderId))!.name).toBe('Repos')
    expect(access.grants).toHaveLength(1)
    expect(await store.sourceRoots()).toHaveLength(1)
  })

  it('upsertText stores text/markdown without revisions; the same content is a no-op, new content one blob write', async () => {
    const { writer, store, blobs } = await setup()
    await writer.ensureRoot('repos', 'GitHub')
    await writer.upsertFolder('repos', 'repo:1', null, 'acme')
    const first = await writer.upsertText('repos', 'repo:1/Overview.md', 'repo:1', 'Overview.md', 'v1')
    expect(first.changed).toBe(true)
    const f1 = (await store.getFile(first.fileId))!
    expect(f1).toMatchObject({ mime: 'text/markdown', sha256: sha256Hex(bytes('v1')), source: 'repos', ownerId: 'repos' })
    expect(await store.listRevisions(first.fileId)).toEqual([])

    const again = await writer.upsertText('repos', 'repo:1/Overview.md', 'repo:1', 'Overview.md', 'v1')
    expect(again).toEqual({ fileId: first.fileId, changed: false })
    expect((await store.getFile(first.fileId))!.updatedAt).toEqual(f1.updatedAt)

    const next = await writer.upsertText('repos', 'repo:1/Overview.md', 'repo:1', 'Overview.md', 'v2')
    expect(next).toEqual({ fileId: first.fileId, changed: true })
    const f2 = (await store.getFile(first.fileId))!
    expect(f2.sha256).toBe(sha256Hex(bytes('v2')))
    expect(f2.updatedAt.getTime()).toBeGreaterThan(f1.updatedAt.getTime())
    expect(await store.listRevisions(first.fileId)).toEqual([])
    // The old bytes are no longer used anywhere, so they're gone.
    expect(await blobs.has(sha256Hex(bytes('v1')))).toBe(false)
    expect(await writer.list('repos')).toEqual([
      { key: 'repo:1', kind: 'folder', itemId: expect.any(String), parentKey: null, contentSha: null },
      { key: 'repo:1/Overview.md', kind: 'file', itemId: first.fileId, parentKey: 'repo:1', contentSha: sha256Hex(bytes('v2')) },
    ])
  })

  it('upsertFolder renames and moves by key, without a second folder', async () => {
    const { writer, store } = await setup()
    const root = await writer.ensureRoot('repos', 'GitHub')
    const a = await writer.upsertFolder('repos', 'repo:1', null, 'acme')
    const docs = await writer.upsertFolder('repos', 'repo:1/docs', 'repo:1', 'docs')
    expect(await writer.upsertFolder('repos', 'repo:1', null, 'acme-renamed')).toBe(a)
    expect((await store.getFolder(a))!).toMatchObject({ name: 'acme-renamed', parentId: root.folderId, source: 'repos' })
    const b = await writer.upsertFolder('repos', 'repo:2', null, 'beta')
    expect(await writer.upsertFolder('repos', 'repo:1/docs', 'repo:2', 'docs')).toBe(docs)
    expect((await store.getFolder(docs))!.parentId).toBe(b)
    await expect(writer.upsertFolder('repos', 'repo:2', 'repo:1/docs', 'beta')).rejects.toThrow(/into itself/)
  })

  it('fails loud: no root yet, a missing parent, a name with /, a key of the other kind', async () => {
    const { writer } = await setup()
    await expect(writer.upsertFolder('repos', 'repo:1', null, 'acme')).rejects.toThrow(/ensureRoot first/)
    await expect(writer.ensureRoot('repos', 'Git/Hub')).rejects.toThrow(/can't contain \//)
    await writer.ensureRoot('repos', 'GitHub')
    await expect(writer.upsertFolder('repos', 'repo:1/docs', 'repo:1', 'docs')).rejects.toThrow(/does not exist/)
    await expect(writer.upsertText('repos', 'repo:1/a', null, 'a/b.md', 'x')).rejects.toThrow(/can't contain \//)
    await writer.upsertText('repos', 'f', null, 'f.md', 'x')
    await expect(writer.upsertFolder('repos', 'f', null, 'f')).rejects.toThrow(/is a file/)
    await expect(writer.upsertText('repos', 'g', 'f', 'g.md', 'x')).rejects.toThrow(/is a file, not a folder/)
  })

  it('remove deletes by key prefix for good (items, rows, unused blobs) and leaves the rest', async () => {
    const { writer, store, blobs, drive } = await setup()
    await writer.ensureRoot('repos', 'GitHub')
    const one = await writer.upsertFolder('repos', 'repo:1', null, 'acme')
    await writer.upsertFolder('repos', 'repo:1/docs', 'repo:1', 'docs')
    const guide = await writer.upsertText('repos', 'repo:1/docs/guide.md', 'repo:1/docs', 'guide.md', 'only here')
    await writer.upsertText('repos', 'repo:1/Overview.md', 'repo:1', 'Overview.md', 'shared bytes')
    await writer.upsertFolder('repos', 'repo:10', null, 'other')
    const keep = await writer.upsertText('repos', 'repo:10/Overview.md', 'repo:10', 'Overview.md', 'shared bytes')
    await drive.setGrants(admin, 'folder', one, [{ subject: { kind: 'company' }, level: 'view' }])

    expect(await writer.remove('repos', 'repo:1')).toBe(4)
    expect((await writer.list('repos')).map((i) => i.key)).toEqual(['repo:10', 'repo:10/Overview.md'])
    expect(await store.getFolder(one)).toBeNull()
    expect(await store.getFile(guide.fileId)).toBeNull()
    expect(await blobs.has(sha256Hex(bytes('only here')))).toBe(false)
    expect(await blobs.has(sha256Hex(bytes('shared bytes')))).toBe(true)
    expect(await store.getFile(keep.fileId)).not.toBeNull()
    expect(await writer.remove('repos', 'repo:1')).toBe(0)
  })
})
