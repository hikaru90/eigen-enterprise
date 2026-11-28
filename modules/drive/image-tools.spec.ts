import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { createDriveImageTools } from './image-tools'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
const coworker = (id: string) => ({ principal: { id, kind: 'coworker' as const, roles: ['member'], agentId: 'a1' }, requestId: 'r' })

async function setup(lookAt = vi.fn(async () => ({ text: 'A blue hero banner reading “Kindred”.', model: 'google/gemini-3.8-flash' }))) {
  const dir = await mkdtemp(join(tmpdir(), 'drive-image-'))
  dirs.push(dir)
  const access = memoryDriveAccess({ users: { alice: { role: 'member' }, cw: { role: 'member' } } })
  const drive = createDriveService({ store: memoryDriveStore(), blobs: diskBlobStore(dir, Buffer.alloc(32, 7)), access, maxUploadBytes: 4 << 20, locks: memoryEditLockStore() })
  const [tool] = createDriveImageTools({ service: async () => drive, lookAt: async () => lookAt as never })
  return { drive, tool: tool!, lookAt }
}

describe('drive.view_image', () => {
  it('is a read every member, co-worker and agent gets', async () => {
    const { tool } = await setup()
    expect(tool.name).toBe('drive.view_image')
    expect(tool.auditClass).toBe('read')
    expect(tool.permission.roles).toEqual(['admin', 'member', 'agent'])
  })

  it('hands a PNG to the vision model as the caller, under drive.image_read', async () => {
    const { drive, tool, lookAt } = await setup()
    const file = await drive.upload({ kind: 'user', userId: 'cw' }, null, { name: 'hero.png', bytes: PNG, mime: 'image/png' }, 'fail')
    const out = await tool.handler(coworker('cw'), { file_id: file.id, question: 'What does it say?' })
    expect(out).toEqual({ file_id: file.id, name: 'hero.png', kind: 'image', text: 'A blue hero banner reading “Kindred”.' })
    expect(lookAt).toHaveBeenCalledWith({
      userId: 'cw',
      task: 'drive.image_read',
      name: 'hero.png',
      attachment: { type: 'image', mime: 'image/png', base64: Buffer.from(PNG).toString('base64') },
      question: 'What does it say?',
    })
  })

  it('refuses a file the caller may not open, and a file that is no image', async () => {
    const { drive, tool } = await setup()
    const mine = await drive.upload({ kind: 'user', userId: 'alice' }, null, { name: 'secret.png', bytes: PNG, mime: 'image/png' }, 'fail')
    await expect(tool.handler(coworker('cw'), { file_id: mine.id })).rejects.toMatchObject({ code: 'not_found' })
    const txt = await drive.upload({ kind: 'user', userId: 'cw' }, null, { name: 'a.png', bytes: new TextEncoder().encode('hi'), mime: 'image/png' }, 'fail')
    await expect(tool.handler(coworker('cw'), { file_id: txt.id })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('says when no AI provider can look', async () => {
    const { drive, tool } = await setup(vi.fn(async () => Promise.reject(new LlmNotConfiguredError('No AI provider.'))))
    const file = await drive.upload({ kind: 'user', userId: 'cw' }, null, { name: 'x.png', bytes: PNG, mime: 'image/png' }, 'fail')
    await expect(tool.handler(coworker('cw'), { file_id: file.id })).rejects.toMatchObject({ code: 'not_configured' })
  })
})
