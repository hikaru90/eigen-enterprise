import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
import { DRIVE_FILE_TOOL_NAMES, DRIVE_TOOL_NAMES, DRIVE_WRITE_TOOLS } from './manifest'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice = { kind: 'user' as const, userId: 'alice' }
const b64 = (s: string) => Buffer.from(s).toString('base64')

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-file-tools-'))
  dirs.push(dir)
  const access = memoryDriveAccess({ users: { alice: { role: 'member' }, bob: { role: 'member' } } })
  let t = 0
  const drive = createDriveService({ store: memoryDriveStore(), blobs: diskBlobStore(dir), access, maxUploadBytes: 64, locks: memoryEditLockStore(), now: () => new Date((t += 1000)) })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((x) => x.name === n)!
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['member'] }, requestId: 'r' })
  return { drive, tool, human }
}

describe('drive file-management tools (UI parity)', () => {
  it('are in the manifest; every write waits on the approval mode', () => {
    for (const n of DRIVE_FILE_TOOL_NAMES) expect(DRIVE_TOOL_NAMES).toContain(n)
    for (const n of DRIVE_WRITE_TOOLS) expect(DRIVE_TOOL_NAMES).toContain(n)
    expect(DRIVE_WRITE_TOOLS).toContain('drive.delete_forever')
    expect(DRIVE_WRITE_TOOLS).not.toContain('drive.list_trash')
  })

  it('drive.create_document makes an empty Table (.csv) or Document when no content is given', async () => {
    const { tool, human } = await setup()
    const out = (await tool('drive.create_document').handler(human('alice'), { name: 'budget', kind: 'csv' })) as { file: { name: string; size: number } }
    expect(out.file).toMatchObject({ name: 'budget.csv', size: 0 })
    const doc = (await tool('drive.create_document').handler(human('alice'), { name: 'notes' })) as { file: { name: string } }
    expect(doc.file.name).toBe('notes.md')
  })

  it('creates a folder, uploads into it, renames, moves, trashes, lists trash, restores and deletes forever', async () => {
    const { tool, human } = await setup()
    const me = human('alice')
    const { folder } = (await tool('drive.create_folder').handler(me, { name: 'Projects' })) as { folder: { id: string } }
    const up = (await tool('drive.upload').handler(me, { folder_id: folder.id, name: 'a.txt', mime_type: 'text/plain', content_base64: b64('hello'), on_conflict: 'fail' })) as { file: { id: string; name: string } }
    expect(up.file.name).toBe('a.txt')
    expect(await tool('drive.rename').handler(me, { type: 'file', id: up.file.id, name: 'b.txt' })).toMatchObject({ item: { name: 'b.txt' } })
    expect(await tool('drive.move').handler(me, { type: 'file', id: up.file.id, folder_id: null })).toMatchObject({ item: { name: 'b.txt' } })
    expect(await tool('drive.list').handler(me, {})).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ name: 'b.txt' })]) })
    await tool('drive.trash').handler(me, { type: 'file', id: up.file.id })
    expect(await tool('drive.list_trash').handler(me, {})).toMatchObject({ items: [{ name: 'b.txt' }] })
    expect(await tool('drive.restore').handler(me, { type: 'file', id: up.file.id })).toMatchObject({ item: { name: 'b.txt' } })
    await expect(tool('drive.delete_forever').handler(me, { type: 'file', id: up.file.id })).rejects.toMatchObject({ code: 'invalid' })
    await tool('drive.trash').handler(me, { type: 'file', id: up.file.id })
    await tool('drive.delete_forever').handler(me, { type: 'file', id: up.file.id })
    expect(await tool('drive.list_trash').handler(me, {})).toEqual({ items: [] })
  })

  it('upload enforces the same size limit and rejects bad base64', async () => {
    const { tool, human } = await setup()
    await expect(
      tool('drive.upload').handler(human('alice'), { name: 'big.bin', mime_type: 'application/octet-stream', content_base64: b64('x'.repeat(65)), on_conflict: 'fail' }),
    ).rejects.toMatchObject({ code: 'too_large' })
    await expect(tool('drive.upload').handler(human('alice'), { name: 'x.bin', mime_type: 'application/octet-stream', content_base64: 'not base64!', on_conflict: 'fail' })).rejects.toThrow()
  })

  it('upload takes the name-clash decision explicitly: fail names the existing file, replace makes a revision, keep_both a “(2)” copy', async () => {
    const { drive, tool, human } = await setup()
    const me = human('alice')
    const up = (on_conflict: string | undefined, body: string) =>
      tool('drive.upload').handler(me, { name: 'a.txt', mime_type: 'text/plain', content_base64: b64(body), ...(on_conflict ? { on_conflict } : {}) })
    await expect(up(undefined, 'one')).rejects.toThrow(/on_conflict/)
    const first = (await up('fail', 'one')) as { file: { id: string }; outcome: string }
    expect(first.outcome).toBe('created')
    await expect(up('fail', 'two')).rejects.toMatchObject({ code: 'conflict', message: '“a.txt” already exists in My drive.', existing: { id: first.file.id } })
    expect(await up('replace', 'two')).toMatchObject({ file: { id: first.file.id, name: 'a.txt' }, outcome: 'replaced' })
    expect(new TextDecoder().decode((await drive.readFile(alice, first.file.id)).bytes)).toBe('two')
    expect(await tool('drive.list_revisions').handler(me, { file_id: first.file.id })).toMatchObject({ revisions: [{ size: 3 }, { size: 3 }] })
    expect(await up('keep_both', 'three')).toMatchObject({ file: { name: 'a (2).txt' }, outcome: 'kept_both' })
  })

  it('saves bytes as a revision, lists revisions and restores one', async () => {
    const { drive, tool, human } = await setup()
    const me = human('alice')
    const f = await drive.upload(alice, null, { name: 'deck.pdf', bytes: new TextEncoder().encode('%PDF-1'), mime: 'application/pdf' })
    await tool('drive.save_file_bytes').handler(me, { file_id: f.id, content_base64: b64('%PDF-2') })
    const { revisions } = (await tool('drive.list_revisions').handler(me, { file_id: f.id })) as { revisions: Array<{ id: string }> }
    expect(revisions).toHaveLength(2)
    await tool('drive.restore_revision').handler(me, { file_id: f.id, revision_id: revisions[1]!.id })
    expect(new TextDecoder().decode((await drive.readFile(alice, f.id)).bytes)).toBe('%PDF-1')
  })

  it('reads and sets sharing as the caller; another person without manage is refused', async () => {
    const { drive, tool, human } = await setup()
    const folder = await drive.createFolder(alice, null, 'Team')
    const grants = [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'view' },
    ]
    expect(await tool('drive.set_sharing').handler(human('alice'), { type: 'folder', id: folder.id, grants })).toMatchObject({
      grants: expect.arrayContaining([expect.objectContaining({ level: 'view' })]),
    })
    expect(((await tool('drive.get_sharing').handler(human('alice'), { type: 'folder', id: folder.id })) as { grants: unknown[] }).grants).toHaveLength(2)
    await expect(tool('drive.set_sharing').handler(human('bob'), { type: 'folder', id: folder.id, grants })).rejects.toBeTruthy()
    await expect(tool('drive.trash').handler(human('bob'), { type: 'folder', id: folder.id })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
