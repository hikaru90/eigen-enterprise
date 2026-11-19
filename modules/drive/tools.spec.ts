import type { SuggestChat } from './archive-suggest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const chat = vi.fn<SuggestChat>()
  // The suggestion's clock runs far ahead of the files': every file counts as long unchanged.
  const tools = createDriveTools({ service: async () => drive, chat, now: () => new Date('2099-01-01T00:00:00Z') })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const human = (id: string) => ({ principal: { id, kind: 'human' as const, roles: ['admin'] }, requestId: 'r' })
  const agent = { principal: { id: 'agent:1', kind: 'agent' as const, roles: ['agent'] }, requestId: 'r' }
  return { drive, tool, human, agent, chat }
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

  it('drive.create_document: a new Markdown file with its text (one revision), the place for internal documents', async () => {
    const { drive, tool, agent } = await setup()
    const create = tool('drive.create_document')
    expect(create).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(create.summary).toMatch(/internal documents/i)
    expect(create.summary).toMatch(/pitch decks/i)
    expect(create.activity!({ name: 'Pitch deck', content: '' }, { file: { name: 'Pitch deck.md' } })).toBe('Created Pitch deck.md in Drive')
    expect(create.activity!({ name: 'Pitch deck', content: '' }, undefined)).toBe('Tried to create Pitch deck in Drive')

    const out = (await create.handler(agent, { name: 'Pitch deck', content: '# Seed round\n' })) as { file: { id: string; name: string } }
    expect(out.file.name).toBe('Pitch deck.md')
    expect(await tool('drive.read').handler(agent, { file_id: out.file.id })).toMatchObject({ content: '# Seed round\n' })
    expect(await drive.listRevisions({ kind: 'agent', id: 'agent:1' }, out.file.id)).toHaveLength(1)
    // A name that already ends in .md keeps it.
    const named = (await create.handler(agent, { name: 'brief.md', content: 'x' })) as { file: { name: string } }
    expect(named.file.name).toBe('brief.md')
  })

  it('drive.create_document working for a person lands in their Drive as theirs, with their own access', async () => {
    const { drive, tool, agent } = await setup()
    const forAlice = { ...agent, actingUserId: 'alice' }
    const out = (await tool('drive.create_document').handler(forAlice, { name: 'Project brief', content: 'b' })) as {
      file: { id: string; ownerId: string }
    }
    expect(out.file.ownerId).toBe('alice')
    expect((await drive.listFolder({ kind: 'user', userId: 'alice' }, null)).items.map((i) => i.name)).toEqual(['Project brief.md'])
    // Into a folder the person cannot see: refused as for them.
    const bobs = await drive.createFolder({ kind: 'user', userId: 'bob' }, null, 'Private')
    await expect(
      tool('drive.create_document').handler(forAlice, { name: 'x', content: 'y', folder_id: bobs.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rejects unknown input keys', async () => {
    const { tool, agent } = await setup()
    await expect(tool('drive.read').handler(agent, { file_id: 'x', path: '/etc' })).rejects.toThrow()
  })

  it('archive tools: archive/unarchive are approval-gated writes with an activity line; listing and suggesting are reads', async () => {
    const { tool } = await setup()
    expect(tool('drive.archive')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('drive.unarchive')).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    expect(tool('drive.list_archived').auditClass).toBe('read')
    expect(tool('drive.suggest_archive').auditClass).toBe('read')
    expect(tool('drive.archive').activity!({ items: [] }, { archived: [{ name: 'a.md' }, { name: 'b.md' }], errors: [] })).toBe('Archived 2 items in Drive')
    expect(tool('drive.archive').activity!({ items: [] }, { archived: [{ name: 'a.md' }], errors: [] })).toBe('Archived a.md in Drive')
    expect(tool('drive.unarchive').activity!({ items: [] }, { unarchived: [{ name: 'a.md' }], errors: [] })).toBe('Brought a.md back from the Drive archive')
  })

  it('the agent archives several items in one call (each checked), lists the archive and brings one back', async () => {
    const { drive, tool, agent } = await setup()
    const a = await drive.createDocument({ kind: 'user', userId: 'alice' }, null, 'md', 'old-a')
    const b = await drive.createDocument({ kind: 'user', userId: 'alice' }, null, 'md', 'old-b')
    const out = await tool('drive.archive').handler(agent, {
      items: [
        { type: 'file', id: a.id },
        { type: 'file', id: b.id },
        { type: 'file', id: 'missing' },
      ],
    })
    expect(out).toMatchObject({ archived: [{ name: 'old-a.md' }, { name: 'old-b.md' }], errors: [{ type: 'file', id: 'missing', error: 'No such file.' }] })
    expect(await tool('drive.list').handler(agent, {})).toMatchObject({ items: [] })
    const listed = (await tool('drive.list_archived').handler(agent, {})) as { groups: Array<{ items: Array<{ name: string }> }> }
    expect(listed.groups.flatMap((g) => g.items.map((i) => i.name)).sort()).toEqual(['old-a.md', 'old-b.md'])
    expect(await tool('drive.unarchive').handler(agent, { items: [{ type: 'file', id: a.id }] })).toMatchObject({ unarchived: [{ name: 'old-a.md' }], errors: [] })
  })

  it('archive as a person: only what they may edit', async () => {
    const { drive, tool, human } = await setup()
    const doc = await drive.createDocument({ kind: 'user', userId: 'alice' }, null, 'md', 'mine')
    expect(await tool('drive.archive').handler(human('bob'), { items: [{ type: 'file', id: doc.id }] })).toMatchObject({
      archived: [],
      errors: [{ id: doc.id, error: 'No such file.' }],
    })
    expect(await tool('drive.archive').handler(human('alice'), { items: [{ type: 'file', id: doc.id }] })).toMatchObject({ archived: [{ name: 'mine.md' }] })
  })

  it('drive.suggest_archive asks the model about candidates and returns suggestions; it archives nothing', async () => {
    const { drive, tool, agent, chat } = await setup()
    const doc = await drive.createDocument({ kind: 'user', userId: 'alice' }, null, 'md', 'ancient')
    chat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ file_id: doc.id, reason: 'Old.' }] }) } }] })
    const out = (await tool('drive.suggest_archive').handler(agent, { older_than_days: 30 })) as {
      suggestions: Array<{ file_id: string; name: string; reason: string }>
    }
    expect(out.suggestions).toEqual([expect.objectContaining({ file_id: doc.id, name: 'ancient.md', reason: 'Old.' })])
    expect((await drive.archived({ kind: 'agent', id: 'agent:1' })).length).toBe(0)
    await expect(tool('drive.suggest_archive').handler(agent, { older_than_days: 30, path: '/' })).rejects.toThrow()
  })

  it('archive input is bounded and strict', async () => {
    const { tool, agent } = await setup()
    await expect(tool('drive.archive').handler(agent, { items: [] })).rejects.toThrow()
    await expect(tool('drive.archive').handler(agent, { items: [{ type: 'doc', id: 'x' }] })).rejects.toThrow()
    await expect(tool('drive.archive').handler(agent, { items: [{ type: 'file', id: 'x' }], force: true })).rejects.toThrow()
  })
})
