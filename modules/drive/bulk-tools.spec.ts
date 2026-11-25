import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
import { DRIVE_BULK_TOOL_NAMES, DRIVE_TOOL_NAMES, DRIVE_WRITE_TOOLS } from './manifest'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

/**
 * The selection bar's acts (Drive: select rows, act on all of them): each
 * bulk tool checks every item exactly as its single tool does and answers
 * per item — what was done, and for the rest which item and why.
 */

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice = { kind: 'user' as const, userId: 'alice' }
const bob = { kind: 'user' as const, userId: 'bob' }
const text = (s: string) => new TextEncoder().encode(s)

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-bulk-tools-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: { alice: { role: 'member' }, bob: { role: 'member' }, carol: { role: 'member' } },
    groups: { team: 'Team' },
  })
  let t = 0
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access,
    maxUploadBytes: 1024,
    locks: memoryEditLockStore(),
    now: () => new Date((t += 1000)),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((x) => x.name === n)!
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['member'] }, requestId: 'r' })
  const file = (name: string, folderId: string | null = null, who = alice) =>
    drive.upload(who, folderId, { name, bytes: text(name), mime: 'text/plain' }, 'fail')
  return { drive, tool, human, file }
}

type Ref = { type: 'file' | 'folder'; id: string }
const ref = (type: Ref['type'], id: string): Ref => ({ type, id })

describe('drive bulk tools (the selection bar)', () => {
  it('are registered, in the manifest, and every one waits on the approval mode', async () => {
    const { tool } = await setup()
    expect(DRIVE_BULK_TOOL_NAMES).toEqual([
      'drive.move_many',
      'drive.trash_many',
      'drive.restore_many',
      'drive.delete_forever_many',
      'drive.share_many',
    ])
    for (const n of DRIVE_BULK_TOOL_NAMES) {
      expect(DRIVE_TOOL_NAMES).toContain(n)
      expect(DRIVE_WRITE_TOOLS).toContain(n)
      expect(tool(n), n).toBeDefined()
      expect(tool(n).auditClass).toBe('mutate')
    }
    expect(tool('drive.delete_forever_many').approvalRisk).toBe('destructive')
  })

  it('refuses an empty list and an unknown item type up front', async () => {
    const { tool, human } = await setup()
    await expect(tool('drive.trash_many').handler(human('alice'), { items: [] })).rejects.toThrow()
    await expect(tool('drive.trash_many').handler(human('alice'), { items: [{ type: 'disk', id: 'x' }] })).rejects.toThrow()
  })

  it('drive.move_many moves each item it may edit and says why for the rest (mixed permissions)', async () => {
    const { drive, tool, human, file } = await setup()
    const target = await drive.createFolder(alice, null, 'Target')
    const a = await file('a.txt')
    const b = await file('b.txt')
    const bobs = await file('bob.txt', null, bob)
    const out = (await tool('drive.move_many').handler(human('alice'), {
      items: [ref('file', a.id), ref('file', bobs.id), ref('file', b.id)],
      folder_id: target.id,
    })) as { moved: Array<{ id: string; parentId: string | null }>; errors: Array<Ref & { error: string }> }
    expect(out.moved.map((m) => m.id)).toEqual([a.id, b.id])
    expect(out.moved.every((m) => m.parentId === target.id)).toBe(true)
    expect(out.errors).toEqual([{ type: 'file', id: bobs.id, error: 'No such file.' }])
    expect((await drive.listFolder(alice, target.id)).items.map((i) => i.name).sort()).toEqual(['a.txt', 'b.txt'])
  })

  it('drive.move_many refuses a target the caller cannot edit for every item, and a folder into itself per item', async () => {
    const { drive, tool, human, file } = await setup()
    const bobsFolder = await drive.createFolder(bob, null, 'Bob only')
    const a = await file('a.txt')
    const out = (await tool('drive.move_many').handler(human('alice'), { items: [ref('file', a.id)], folder_id: bobsFolder.id })) as {
      moved: unknown[]
      errors: Array<{ error: string }>
    }
    expect(out.moved).toEqual([])
    expect(out.errors).toEqual([{ type: 'file', id: a.id, error: 'No such folder.' }])

    const box = await drive.createFolder(alice, null, 'Box')
    const inner = await drive.createFolder(alice, box.id, 'Inner')
    const self = (await tool('drive.move_many').handler(human('alice'), {
      items: [ref('folder', box.id), ref('file', a.id)],
      folder_id: inner.id,
    })) as { moved: Array<{ id: string }>; errors: Array<Ref & { error: string }> }
    expect(self.moved.map((m) => m.id)).toEqual([a.id])
    expect(self.errors).toEqual([{ type: 'folder', id: box.id, error: 'A folder can’t move into itself.' }])
  })

  it('drive.trash_many trashes what it may edit; view-only items stay and are named (mixed permissions)', async () => {
    const { drive, tool, human, file } = await setup()
    const shared = await file('shared.txt', null, bob)
    await drive.setGrants(bob, 'file', shared.id, [
      { subject: { kind: 'user', userId: 'bob' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'alice' }, level: 'view' },
    ])
    const mine = await file('mine.txt')
    const out = (await tool('drive.trash_many').handler(human('alice'), { items: [ref('file', mine.id), ref('file', shared.id)] })) as {
      trashed: Array<{ id: string }>
      errors: Array<Ref & { error: string }>
    }
    expect(out.trashed.map((x) => x.id)).toEqual([mine.id])
    expect(out.errors).toEqual([{ type: 'file', id: shared.id, error: 'You can view this file but not change it.' }])
    expect((await drive.trash(alice)).map((i) => i.id)).toEqual([mine.id])
  })

  it('drive.trash_many takes a folder and something inside it together (children first, no spurious error)', async () => {
    const { drive, tool, human, file } = await setup()
    const box = await drive.createFolder(alice, null, 'Box')
    const inside = await file('inside.txt', box.id)
    const out = (await tool('drive.trash_many').handler(human('alice'), { items: [ref('folder', box.id), ref('file', inside.id)] })) as {
      trashed: Array<{ id: string }>
      errors: unknown[]
    }
    expect(out.errors).toEqual([])
    expect(out.trashed.map((x) => x.id).sort()).toEqual([box.id, inside.id].sort())
  })

  it('drive.restore_many restores each trashed item and says which were not in the trash', async () => {
    const { drive, tool, human, file } = await setup()
    const a = await file('a.txt')
    const b = await file('b.txt')
    const live = await file('live.txt')
    await drive.moveToTrash(alice, 'file', a.id)
    await drive.moveToTrash(alice, 'file', b.id)
    const out = (await tool('drive.restore_many').handler(human('alice'), {
      items: [ref('file', a.id), ref('file', live.id), ref('file', b.id)],
    })) as { restored: Array<{ id: string }>; errors: Array<Ref & { error: string }> }
    expect(out.restored.map((x) => x.id)).toEqual([a.id, b.id])
    expect(out.errors).toEqual([{ type: 'file', id: live.id, error: 'That file is not in the trash.' }])
  })

  it('drive.restore_many restores a folder before what was inside it, so the item goes back into its folder', async () => {
    const { drive, tool, human, file } = await setup()
    const box = await drive.createFolder(alice, null, 'Box')
    const inside = await file('inside.txt', box.id)
    await drive.moveToTrash(alice, 'file', inside.id)
    await drive.moveToTrash(alice, 'folder', box.id)
    const out = (await tool('drive.restore_many').handler(human('alice'), { items: [ref('file', inside.id), ref('folder', box.id)] })) as {
      restored: Array<{ id: string; parentId: string | null }>
      errors: unknown[]
    }
    expect(out.errors).toEqual([])
    expect(out.restored.find((r) => r.id === inside.id)?.parentId).toBe(box.id)
  })

  it('drive.delete_forever_many needs manage per item and the trash first; it names each refusal (partial failure)', async () => {
    const { drive, tool, human, file } = await setup()
    const mine = await file('mine.txt')
    const live = await file('live.txt')
    const edited = await file('edited.txt', null, bob)
    await drive.setGrants(bob, 'file', edited.id, [
      { subject: { kind: 'user', userId: 'bob' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'alice' }, level: 'edit' },
    ])
    await drive.moveToTrash(alice, 'file', mine.id)
    await drive.moveToTrash(alice, 'file', edited.id)
    const out = (await tool('drive.delete_forever_many').handler(human('alice'), {
      items: [ref('file', mine.id), ref('file', live.id), ref('file', edited.id)],
    })) as { deleted: Array<Ref & { name: string }>; errors: Array<Ref & { error: string }> }
    expect(out.deleted).toEqual([{ type: 'file', id: mine.id, name: 'mine.txt' }])
    expect(out.errors).toEqual([
      { type: 'file', id: live.id, error: 'Move it to the trash first.' },
      { type: 'file', id: edited.id, error: 'You can’t manage this file.' },
    ])
    await expect(drive.readFile(alice, mine.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('drive.delete_forever_many takes a trashed folder and a trashed item inside it together without a spurious error', async () => {
    const { drive, tool, human, file } = await setup()
    const box = await drive.createFolder(alice, null, 'Box')
    const inside = await file('inside.txt', box.id)
    await drive.moveToTrash(alice, 'file', inside.id)
    await drive.moveToTrash(alice, 'folder', box.id)
    const out = (await tool('drive.delete_forever_many').handler(human('alice'), { items: [ref('folder', box.id), ref('file', inside.id)] })) as {
      deleted: Array<{ id: string }>
      errors: unknown[]
    }
    expect(out.errors).toEqual([])
    expect(out.deleted.map((d) => d.id).sort()).toEqual([box.id, inside.id].sort())
  })

  it('drive.share_many adds the grants to each item it may manage, never lowers or removes access, and names the rest', async () => {
    const { drive, tool, human, file } = await setup()
    const a = await file('a.txt')
    const b = await file('b.txt')
    await drive.setGrants(alice, 'file', b.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'carol' }, level: 'manage' },
    ])
    const bobs = await file('bob.txt', null, bob)
    await drive.setGrants(bob, 'file', bobs.id, [
      { subject: { kind: 'user', userId: 'bob' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'alice' }, level: 'edit' },
    ])
    const out = (await tool('drive.share_many').handler(human('alice'), {
      items: [ref('file', a.id), ref('file', b.id), ref('file', bobs.id)],
      grants: [
        { subject: { kind: 'user', userId: 'carol' }, level: 'edit' },
        { subject: { kind: 'group', groupId: 'team' }, level: 'view' },
      ],
    })) as { shared: Array<{ id: string }>; errors: Array<Ref & { error: string }> }
    expect(out.shared.map((s) => s.id)).toEqual([a.id, b.id])
    expect(out.errors).toEqual([{ type: 'file', id: bobs.id, error: 'You can’t manage this file.' }])
    const levels = async (id: string) =>
      Object.fromEntries(
        (await drive.getGrants(alice, 'file', id)).map((g) => [
          g.subject.kind === 'user' ? g.subject.userId : g.subject.kind === 'group' ? `group:${g.subject.groupId}` : 'company',
          g.level,
        ]),
      )
    expect(await levels(a.id)).toMatchObject({ carol: 'edit', 'group:team': 'view' })
    // carol already managed b: sharing many adds access, it never takes any away.
    expect(await levels(b.id)).toEqual({ alice: 'manage', carol: 'manage', 'group:team': 'view' })
  })

  it('drive.share_many refuses naming the same person twice before touching anything', async () => {
    const { tool, human, file } = await setup()
    const a = await file('a.txt')
    await expect(
      tool('drive.share_many').handler(human('alice'), {
        items: [ref('file', a.id)],
        grants: [
          { subject: { kind: 'user', userId: 'carol' }, level: 'edit' },
          { subject: { kind: 'user', userId: 'carol' }, level: 'view' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
})
