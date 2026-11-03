import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAccess } from '$lib/server/access'
import { memoryAccessStore } from '$lib/server/access/memory-store'
import { contractDriveAccess } from './access-port'
import { memoryEditLockStore } from './locks'
import { createDriveService, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

/** Drive through the REAL access contract (createAccess + its memory store): chain inheritance, groups, audit, resolvers. */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const u = (userId: string): Actor => ({ kind: 'user', userId })

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-contract-'))
  dirs.push(dir)
  const driveStore = memoryDriveStore()
  const store = memoryAccessStore({ users: { o: 'owner', a: 'member', b: 'member', c: 'member' }, groups: { design: ['c'] }, grants: [] })
  const audit = vi.fn(async () => {})
  const resolvers = {
    folder: async (id: string) => (await driveStore.getFolder(id)) !== null,
    file: async (id: string) => (await driveStore.getFile(id)) !== null,
  }
  const access = createAccess({ store, audit, resolvers })
  const port = contractDriveAccess({ access, store, shareTargets: async () => ({ people: [], groups: [] }) })
  const drive = createDriveService({ store: driveStore, blobs: diskBlobStore(dir), access: port, maxUploadBytes: 1 << 20, locks: memoryEditLockStore() })
  return { drive, audit, store }
}

describe('drive over the real access contract', () => {
  it('a member creating a folder becomes its manager through the contract (initializeGrants)', async () => {
    const { drive, store } = await setup()
    const f = await drive.createFolder(u('a'), null, 'Mine')
    expect(await store.grantsOn([{ resourceType: 'folder', resourceId: f.id }])).toEqual([
      { resourceType: 'folder', resourceId: f.id, subject: { kind: 'user', userId: 'a' }, level: 'manage' },
    ])
  })

  it('the creator shares a folder (audited as them); view inherits through the chain, edit lets a group rename', async () => {
    const { drive, audit } = await setup()
    const f = await drive.createFolder(u('a'), null, 'Projects')
    const sub = await drive.createFolder(u('a'), f.id, 'Deep')
    const doc = await drive.createDocument(u('a'), sub.id, 'md', 'notes')
    await expect(drive.readText(u('b'), doc.id)).rejects.toMatchObject({ code: 'not_found' })

    await drive.setGrants(u('a'), 'folder', f.id, [
      { subject: { kind: 'user', userId: 'a' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'b' }, level: 'view' },
      { subject: { kind: 'group', groupId: 'design' }, level: 'edit' },
    ])
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.grants_set', principalId: 'a' }))
    expect((await drive.readText(u('b'), doc.id)).content).toBe('')
    await expect(drive.rename(u('b'), 'file', doc.id, 'x.md')).rejects.toMatchObject({ code: 'forbidden' })
    expect(await drive.rename(u('c'), 'file', doc.id, 'by-c.md')).toMatchObject({ name: 'by-c.md' })
    expect((await drive.sharedWithMe(u('b'))).map((i) => i.name)).toEqual(['Projects'])
    expect(await drive.fileInfo(u('o'), doc.id)).toMatchObject({ canManage: true })
  })

  it('a member without manage cannot share; unknown members are refused plainly; delete forever drops the grants', async () => {
    const { drive, store } = await setup()
    const f = await drive.createFolder(u('a'), null, 'P')
    await drive.setGrants(u('a'), 'folder', f.id, [
      { subject: { kind: 'user', userId: 'a' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'b' }, level: 'edit' },
    ])
    await expect(drive.setGrants(u('b'), 'folder', f.id, [])).rejects.toMatchObject({ code: 'forbidden' })
    await expect(drive.setGrants(u('a'), 'folder', f.id, [{ subject: { kind: 'user', userId: 'a' }, level: 'manage' }, { subject: { kind: 'user', userId: 'ghost' }, level: 'view' }])).rejects.toMatchObject({
      code: 'invalid',
    })
    await drive.moveToTrash(u('a'), 'folder', f.id)
    await drive.deleteForever(u('a'), 'folder', f.id)
    expect(await store.grantsOn([{ resourceType: 'folder', resourceId: f.id }])).toEqual([])
  })
})
