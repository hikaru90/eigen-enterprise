import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-tools-'))
  dirs.push(dir)
  const access = memoryDriveAccess({ users: { alice: { role: 'member' }, bob: { role: 'member' } } })
  const drive = createDriveService({ store: memoryDriveStore(), blobs: diskBlobStore(dir), access, maxUploadBytes: 1 << 20, locks: memoryEditLockStore() })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['admin'] }, requestId: 'r' })
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
  return { drive, tool, human, agent }
}

describe('drive.* tools', () => {
  it('declares read/mutate classes, approval risk and an activity sentence', async () => {
    const { tool } = await setup()
    expect(tool('drive.list').auditClass).toBe('read')
    expect(tool('drive.read').auditClass).toBe('read')
    expect(tool('drive.write_text')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('drive.write_text').activity!({ file_id: 'f', content: '' }, { file: { name: 'notes.md' } })).toBe(
      'Saved a new version of notes.md in Drive',
    )
  })

  it('every tool is access-checked as the calling person (fail closed)', async () => {
    const { drive, tool, human } = await setup()
    const folder = await drive.createFolder({ kind: 'user', userId: 'alice' }, null, 'Projects')
    const doc = await drive.createDocument({ kind: 'user', userId: 'alice' }, folder.id, 'md', 'notes')
    await expect(tool('drive.list').handler(human('bob'), { folder_id: folder.id })).rejects.toMatchObject({ code: 'not_found' })
    await expect(tool('drive.read').handler(human('bob'), { file_id: doc.id })).rejects.toMatchObject({ code: 'not_found' })
    await expect(tool('drive.write_text').handler(human('bob'), { file_id: doc.id, content: 'x' })).rejects.toMatchObject({ code: 'not_found' })
    await drive.setGrants({ kind: 'user', userId: 'alice' }, 'folder', folder.id, [{ subject: { kind: 'user', userId: 'alice' }, level: 'manage' }, { subject: { kind: 'user', userId: 'bob' }, level: 'view' }])
    expect(await tool('drive.list').handler(human('bob'), { folder_id: folder.id })).toMatchObject({ items: [{ name: 'notes.md' }] })
    expect(await tool('drive.read').handler(human('bob'), { file_id: doc.id })).toMatchObject({ content: '' })
    await expect(tool('drive.write_text').handler(human('bob'), { file_id: doc.id, content: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('the agent lists, reads and writes (a new revision)', async () => {
    const { drive, tool, agent } = await setup()
    const doc = await drive.createDocument({ kind: 'user', userId: 'alice' }, null, 'csv', 'budget')
    expect(await tool('drive.list').handler(agent, {})).toMatchObject({ items: [{ name: 'budget.csv' }] })
    await tool('drive.write_text').handler(agent, { file_id: doc.id, content: 'a,b\n' })
    expect(await tool('drive.read').handler(agent, { file_id: doc.id })).toMatchObject({ content: 'a,b\n' })
    expect(await drive.listRevisions({ kind: 'agent', id: 'agent:1' }, doc.id)).toHaveLength(1)
  })

  it('rejects unknown input keys', async () => {
    const { tool, agent } = await setup()
    await expect(tool('drive.read').handler(agent, { file_id: 'x', path: '/etc' })).rejects.toThrow()
  })
})
