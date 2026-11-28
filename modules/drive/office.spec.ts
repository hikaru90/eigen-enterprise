import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OfficeNotSupportedError, type OfficeKind } from '$lib/office/kinds'
import { memoryEditLockStore } from './locks'
import { memoryDriveAccess } from './memory-access'
import { createDriveService, DriveError, type Actor } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'

/** Text extraction is each format's own work (src/lib/office/<kind>/text.ts); here only the dispatch is under test. */
const extract = vi.hoisted(() => ({ fn: vi.fn<(kind: OfficeKind, bytes: Uint8Array) => Promise<string>>() }))
vi.mock('$lib/office/text', () => ({ extractOfficeText: extract.fn }))

const dirs: string[] = []
afterEach(async () => {
  extract.fn.mockReset()
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice: Actor = { kind: 'user', userId: 'alice' }
const bob: Actor = { kind: 'user', userId: 'bob' }
const agent: Actor = { kind: 'agent', id: 'agent:1' }
const text = (s: string) => new TextEncoder().encode(s)
const pdf = (s: string) => text(`%PDF-1.7\n${s}`)
const zip = (s: string) => new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...text(s)])

async function setup(maxUploadBytes = 1024) {
  const dir = await mkdtemp(join(tmpdir(), 'drive-office-'))
  dirs.push(dir)
  const store = memoryDriveStore()
  const blobs = diskBlobStore(dir, Buffer.alloc(32, 7))
  const access = memoryDriveAccess({ users: { owner: { role: 'owner' }, alice: { role: 'member' }, bob: { role: 'member' } }, groups: {} })
  let t = Date.parse('2026-11-20T10:00:00Z')
  const drive = createDriveService({ store, blobs, access, maxUploadBytes, locks: memoryEditLockStore(), now: () => new Date((t += 1000)) })
  return { drive, store, blobs }
}

async function expectCode(p: Promise<unknown>, code: DriveError['code']) {
  await expect(p).rejects.toMatchObject({ code })
}

describe('drive: office files (PDF, Word, PowerPoint) keep binary revisions', () => {
  it('an upload starts the history; each save is a new revision of the bytes', async () => {
    const { drive, blobs } = await setup()
    const f = await drive.upload(alice, null, { name: 'plan.pdf', bytes: pdf('v1'), mime: 'application/pdf' }, 'fail')
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(1)
    const out = await drive.writeBytes(alice, f.id, pdf('v2'))
    expect(out.file.size).toBe(pdf('v2').byteLength)
    const revs = await drive.listRevisions(alice, f.id)
    expect(revs).toHaveLength(2)
    expect(new TextDecoder().decode(await blobs.get(revs[0]!.sha256))).toContain('v2')
    expect(new TextDecoder().decode((await drive.readFile(alice, f.id)).bytes)).toContain('v2')
  })

  it('a file that has no revision yet (uploaded before office files kept history) keeps its original as the first one', async () => {
    const { drive, store, blobs } = await setup()
    const blob = await blobs.put(zip('old'))
    const at = new Date('2026-01-01T00:00:00Z')
    await store.insertFile({
      id: 'legacy-deck', folderId: null, name: 'deck.pptx', ownerId: 'alice', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size: blob.size, sha256: blob.sha256, createdAt: at, updatedAt: at, trashedAt: null, archivedAt: null, archivedBy: null, source: null, contentDate: null, contentDateKind: null,
    })
    await drive.setGrants(agent, 'file', 'legacy-deck', [{ subject: { kind: 'user', userId: 'alice' }, level: 'manage' }])
    await drive.writeBytes(alice, 'legacy-deck', zip('new'))
    const revs = await drive.listRevisions(alice, 'legacy-deck')
    expect(revs.map((r) => r.sha256)).toEqual([(await blobs.put(zip('new'))).sha256, blob.sha256])
  })

  it('saves under one edit session fold into one revision, like text', async () => {
    const { drive } = await setup()
    const f = await drive.upload(alice, null, { name: 'letter.docx', bytes: zip('a'), mime: null }, 'fail')
    expect(await drive.acquireLock(alice, f.id, 'session-a1')).toMatchObject({ state: 'held' })
    await drive.writeBytes(alice, f.id, zip('b'), 'session-a1')
    await drive.writeBytes(alice, f.id, zip('c'), 'session-a1')
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(2)
  })

  it('refuses bytes of another format, text files, view-only people and someone else’s live lock', async () => {
    const { drive } = await setup()
    const f = await drive.upload(alice, null, { name: 'plan.pdf', bytes: pdf('v1'), mime: 'application/pdf' }, 'fail')
    await expect(drive.writeBytes(alice, f.id, zip('not a pdf'))).rejects.toThrow(/not a PDF/)
    const d = await drive.upload(alice, null, { name: 'letter.docx', bytes: zip('a'), mime: null }, 'fail')
    await expect(drive.writeBytes(alice, d.id, pdf('not a docx'))).rejects.toThrow(/not a Word/)
    const md = await drive.createDocument(alice, null, 'md', 'notes')
    await expectCode(drive.writeBytes(alice, md.id, text('# hi')), 'invalid')
    await expectCode(drive.writeText(alice, f.id, 'text into a pdf'), 'invalid')
    await drive.setGrants(alice, 'file', f.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'view' },
    ])
    await expectCode(drive.writeBytes(bob, f.id, pdf('v2')), 'forbidden')
    await drive.acquireLock(alice, f.id, 'session-a1')
    await expectCode(drive.writeBytes(agent, f.id, pdf('v2')), 'locked')
  })

  it('a save that names the content it started from is refused when the file changed since (no silent overwrite)', async () => {
    const { drive, blobs } = await setup()
    const f = await drive.upload(alice, null, { name: 'budget.xlsx', bytes: zip('v1'), mime: null }, 'fail')
    const v1 = (await blobs.put(zip('v1'))).sha256
    // Another tab saves v2 in between.
    await drive.writeBytes(alice, f.id, zip('v2'))
    await expectCode(drive.writeBytes(alice, f.id, zip('mine'), undefined, { baseSha256: v1 }), 'conflict')
    expect(new TextDecoder().decode((await drive.readFile(alice, f.id)).bytes)).toContain('v2')
    // Started from the current content: saved.
    const v2 = (await blobs.put(zip('v2'))).sha256
    await drive.writeBytes(alice, f.id, zip('mine'), undefined, { baseSha256: v2 })
    expect(new TextDecoder().decode((await drive.readFile(alice, f.id)).bytes)).toContain('mine')
  })

  it('refuses a save over the size limit', async () => {
    const { drive } = await setup(64)
    const f = await drive.upload(alice, null, { name: 'plan.pdf', bytes: pdf('v1'), mime: 'application/pdf' }, 'fail')
    await expectCode(drive.writeBytes(alice, f.id, pdf('x'.repeat(100))), 'too_large')
  })
})

describe('drive: reading an office file as text', () => {
  it('hands the bytes to its format’s text extraction', async () => {
    const { drive } = await setup()
    extract.fn.mockResolvedValue('# Plan\n\nPage one')
    const f = await drive.upload(alice, null, { name: 'plan.pdf', bytes: pdf('v1'), mime: 'application/pdf' }, 'fail')
    expect((await drive.readText(alice, f.id)).content).toBe('# Plan\n\nPage one')
    expect(extract.fn).toHaveBeenCalledWith('pdf', pdf('v1'))
  })

  it('a format without text extraction yet says so plainly', async () => {
    const { drive } = await setup()
    extract.fn.mockRejectedValue(new OfficeNotSupportedError('pptx', 'reading text'))
    const f = await drive.upload(alice, null, { name: 'deck.pptx', bytes: zip('a'), mime: null }, 'fail')
    await expect(drive.readText(alice, f.id)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/PowerPoint.*not supported yet/) })
  })

  it('a broken file fails loud, not as empty text', async () => {
    const { drive } = await setup()
    extract.fn.mockRejectedValue(new Error('bad xref table'))
    const f = await drive.upload(alice, null, { name: 'plan.pdf', bytes: pdf('v1'), mime: 'application/pdf' }, 'fail')
    await expect(drive.readText(alice, f.id)).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/could not be read: bad xref table/) })
  })
})

describe('drive: earlier versions of an office file', () => {
  it('reads the bytes of one revision, and restoring one saves it again as the newest', async () => {
    const { drive } = await setup()
    const f = await drive.upload(alice, null, { name: 'plan.pdf', bytes: pdf('v1'), mime: 'application/pdf' }, 'fail')
    await drive.writeBytes(alice, f.id, pdf('v2'))
    const [, first] = await drive.listRevisions(alice, f.id)
    const old = await drive.readRevisionBytes(alice, f.id, first!.id)
    expect(new TextDecoder().decode(old.bytes)).toContain('v1')
    expect(old.file.name).toBe('plan.pdf')
    await drive.restoreRevision(alice, f.id, first!.id)
    expect(new TextDecoder().decode((await drive.readFile(alice, f.id)).bytes)).toContain('v1')
    expect(await drive.listRevisions(alice, f.id)).toHaveLength(3)
  })

  it('a revision of another file, or of a file you cannot see, is not found', async () => {
    const { drive } = await setup()
    const a = await drive.upload(alice, null, { name: 'a.pdf', bytes: pdf('a'), mime: 'application/pdf' }, 'fail')
    const b = await drive.upload(alice, null, { name: 'b.pdf', bytes: pdf('b'), mime: 'application/pdf' }, 'fail')
    const [revA] = await drive.listRevisions(alice, a.id)
    await expectCode(drive.readRevisionBytes(alice, b.id, revA!.id), 'not_found')
    await expectCode(drive.readRevisionBytes(bob, a.id, revA!.id), 'not_found')
  })
})
