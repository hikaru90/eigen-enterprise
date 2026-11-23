import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib/dist/pdf-lib.esm.js'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { encryptedPdf, makePdf } from '$lib/office/pdf/fixtures'
import { pageRangesLabel } from '$lib/office/pdf/organise-plan'
import { extractText } from '$lib/office/pdf/text'
import { memoryEditLockStore } from './locks'
import { DRIVE_PDF_TOOL_NAMES, DRIVE_TOOL_NAMES } from './manifest'
import { memoryDriveAccess } from './memory-access'
import { createDriveService } from './service'
import { diskBlobStore } from './storage'
import { memoryDriveStore } from './store'
import { createDriveTools } from './tools'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const alice: Actor = { kind: 'user', userId: 'alice' }
const bob: Actor = { kind: 'user', userId: 'bob' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-pdf-tools-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: { alice: { role: 'member' }, bob: { role: 'member' } },
  })
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access,
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const tools = createDriveTools({ service: async () => drive })
  const tool = (n: string) => tools.find((t) => t.name === n)!
  const as = (id: string) => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, 'orchestrator'),
    requestId: 'r',
  })
  const folder = await drive.createFolder(alice, null, 'Reports')
  const pdf = async (n: number, name = 'report.pdf', opts: Parameters<typeof makePdf>[1] = {}) =>
    drive.upload(alice, folder.id, {
      name,
      bytes: await makePdf(
        Array.from({ length: n }, (_, i) => ({ lines: [`${name} page ${i + 1}`] })),
        opts,
      ),
      mime: 'application/pdf',
    }, 'fail')
  const heads = async (id: string) => {
    const text = await extractText((await drive.readFile(alice, id)).bytes)
    return [...text.matchAll(/^(\S+\.pdf page \d+)$/gm)].map((m) => m[1])
  }
  return { drive, tool, as, folder, pdf, heads }
}

describe('drive.pdf_* tools (Organise as registry actions)', () => {
  it('are registered Drive tools: mutate, approval risk internal, with an activity sentence', async () => {
    const { tool } = await setup()
    for (const name of DRIVE_PDF_TOOL_NAMES) {
      expect(DRIVE_TOOL_NAMES).toContain(name)
      expect(tool(name)).toMatchObject({
        module: 'drive',
        auditClass: 'mutate',
        approvalRisk: 'internal',
      })
    }
    expect(
      tool('drive.pdf_rotate').activity!(
        { file_id: 'f', pages: [1, 2], degrees: 90 },
        { file: { name: 'report.pdf' } },
      ),
    ).toBe('Rotated 2 pages of report.pdf in Drive')
    expect(tool('drive.pdf_delete_pages').activity!({ file_id: 'f', pages: [3] }, undefined)).toBe(
      'Tried to delete pages from file f in Drive',
    )
    expect(
      tool('drive.pdf_extract_pages').activity!(
        { file_id: 'f', pages: [2] },
        { file: { name: 'report (pages 2).pdf' }, source: { name: 'report.pdf' } },
      ),
    ).toBe('Extracted 1 page of report.pdf into report (pages 2).pdf in Drive')
    expect(
      tool('drive.pdf_split').activity!(
        { file_id: 'f', ranges: [] },
        { files: [{}, {}], source: { name: 'report.pdf' } },
      ),
    ).toBe('Split report.pdf into 2 files in Drive')
    expect(
      tool('drive.pdf_merge').activity!({ file_ids: ['a', 'b'] }, { file: { name: 'all.pdf' } }),
    ).toBe('Merged 2 PDFs into all.pdf in Drive')
  })

  it('drive.pdf_rotate turns pages (numbered from 1) and saves a new revision', async () => {
    const { drive, tool, as, pdf } = await setup()
    const file = await pdf(3)
    const out = (await tool('drive.pdf_rotate').handler(as('alice'), {
      file_id: file.id,
      pages: [2, 3],
      degrees: 90,
    })) as { file: { name: string }; warnings: string[] }
    expect(out).toMatchObject({ file: { name: 'report.pdf' }, warnings: [] })
    const doc = await PDFDocument.load((await drive.readFile(alice, file.id)).bytes)
    expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([0, 90, 90])
    expect(await drive.listRevisions(alice, file.id)).toHaveLength(2)
  })

  it('drive.pdf_delete_pages deletes pages and reports what went with them', async () => {
    const { tool, as, pdf, heads } = await setup()
    const file = await pdf(4, 'report.pdf', { outline: [{ title: 'Annex', page: 3 }] })
    const out = (await tool('drive.pdf_delete_pages').handler(as('alice'), {
      file_id: file.id,
      pages: [4, 2],
    })) as { warnings: string[] }
    expect(await heads(file.id)).toEqual(['report.pdf page 1', 'report.pdf page 3'])
    expect(out.warnings).toEqual(['A bookmark went to deleted pages and was removed: “Annex”.'])
  })

  it('drive.pdf_reorder takes a full order or moves pages to a position', async () => {
    const { tool, as, pdf, heads } = await setup()
    const file = await pdf(4)
    await tool('drive.pdf_reorder').handler(as('alice'), { file_id: file.id, order: [4, 3, 2, 1] })
    expect(await heads(file.id)).toEqual([4, 3, 2, 1].map((n) => `report.pdf page ${n}`))
    await tool('drive.pdf_reorder').handler(as('alice'), { file_id: file.id, pages: [1, 2], to: 3 })
    expect(await heads(file.id)).toEqual([2, 1, 4, 3].map((n) => `report.pdf page ${n}`))
    await expect(
      tool('drive.pdf_reorder').handler(as('alice'), { file_id: file.id, order: [1, 2] }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('every page once'),
    })
  })

  it('drive.pdf_extract_pages makes a new PDF next to the source, which stays as it is', async () => {
    const { drive, tool, as, pdf, heads, folder } = await setup()
    const file = await pdf(5)
    const out = (await tool('drive.pdf_extract_pages').handler(as('alice'), {
      file_id: file.id,
      pages: [2, 3, 5],
    })) as { file: { id: string; name: string; parentId: string | null } }
    expect(out.file).toMatchObject({ name: 'report (pages 2–3, 5).pdf', parentId: folder.id })
    expect(await heads(out.file.id)).toEqual([2, 3, 5].map((n) => `report.pdf page ${n}`))
    expect(await heads(file.id)).toHaveLength(5)
    const named = (await tool('drive.pdf_extract_pages').handler(as('alice'), {
      file_id: file.id,
      pages: [1],
      name: 'Cover',
      folder_id: null,
    })) as { file: { name: string; parentId: string | null } }
    expect(named.file).toMatchObject({ name: 'Cover.pdf', parentId: null })
    expect((await drive.listFolder(alice, folder.id)).items.map((i) => i.name).sort()).toEqual([
      'report (pages 2–3, 5).pdf',
      'report.pdf',
    ])
  })

  it('drive.pdf_split makes one new PDF per range', async () => {
    const { tool, as, pdf, heads } = await setup()
    const file = await pdf(5)
    const out = (await tool('drive.pdf_split').handler(as('alice'), {
      file_id: file.id,
      ranges: [
        { from: 1, to: 2 },
        { from: 3, to: 5 },
        { from: 4, to: 4 },
      ],
    })) as { files: Array<{ id: string; name: string }> }
    expect(out.files.map((f) => f.name)).toEqual([
      'report (pages 1–2).pdf',
      'report (pages 3–5).pdf',
      'report (page 4).pdf',
    ])
    expect(await heads(out.files[1]!.id)).toEqual([3, 4, 5].map((n) => `report.pdf page ${n}`))
  })

  it('drive.pdf_merge makes one new PDF of several, in order', async () => {
    const { tool, as, pdf, heads } = await setup()
    const a = await pdf(2, 'a.pdf')
    const b = await pdf(1, 'b.pdf')
    const out = (await tool('drive.pdf_merge').handler(as('alice'), {
      file_ids: [b.id, a.id],
      name: 'Bundle',
    })) as { file: { id: string; name: string } }
    expect(out.file.name).toBe('Bundle.pdf')
    expect(await heads(out.file.id)).toEqual(['b.pdf page 1', 'a.pdf page 1', 'a.pdf page 2'])
    const unnamed = (await tool('drive.pdf_merge').handler(as('alice'), {
      file_ids: [a.id, b.id],
    })) as { file: { name: string } }
    expect(unnamed.file.name).toBe('a (merged).pdf')
  })

  it('is access-checked as the caller: unseen files are not found, view-only can’t change them', async () => {
    const { drive, tool, as, pdf, folder } = await setup()
    const file = await pdf(2)
    await expect(
      tool('drive.pdf_rotate').handler(as('bob'), { file_id: file.id, pages: [1], degrees: 90 }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await drive.setGrants(alice, 'folder', folder.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'view' },
    ])
    await expect(
      tool('drive.pdf_delete_pages').handler(as('bob'), { file_id: file.id, pages: [1] }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // Extracting next to the source needs edit access to its folder …
    await expect(
      tool('drive.pdf_extract_pages').handler(as('bob'), { file_id: file.id, pages: [1] }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // … into their own Drive it is theirs.
    const own = (await tool('drive.pdf_extract_pages').handler(as('bob'), {
      file_id: file.id,
      pages: [1],
      folder_id: null,
    })) as { file: { ownerId: string } }
    expect(own.file.ownerId).toBe('bob')
    expect((await drive.listFolder(bob, null)).items.map((i) => i.name)).toContain(
      'report (pages 1).pdf',
    )
  })

  it('refuses while someone has the PDF open for editing (the edit lock)', async () => {
    const { drive, tool, as, pdf, folder } = await setup()
    const file = await pdf(2)
    await drive.setGrants(alice, 'folder', folder.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'edit' },
    ])
    expect(await drive.acquireLock(bob, file.id, 'tab-bob')).toMatchObject({ state: 'held' })
    await expect(
      tool('drive.pdf_rotate').handler(as('alice'), { file_id: file.id, pages: [1], degrees: 90 }),
    ).rejects.toMatchObject({ code: 'locked' })
  })

  it('says plainly what can’t be done', async () => {
    const { drive, tool, as, pdf, folder } = await setup()
    const file = await pdf(2)
    await expect(
      tool('drive.pdf_delete_pages').handler(as('alice'), { file_id: file.id, pages: [3] }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'There is no page 3; the PDF has 2 pages.',
    })
    await expect(
      tool('drive.pdf_delete_pages').handler(as('alice'), { file_id: file.id, pages: [1, 2] }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('at least one page'),
    })
    await expect(
      tool('drive.pdf_rotate').handler(as('alice'), { file_id: file.id, pages: [0], degrees: 90 }),
    ).rejects.toThrow()
    const notes = await drive.createDocument(alice, folder.id, 'md', 'notes', '# hi')
    await expect(
      tool('drive.pdf_rotate').handler(as('alice'), { file_id: notes.id, pages: [1], degrees: 90 }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: '“notes.md” is not a PDF, so its pages can’t be organised.',
    })
    const locked = await drive.upload(alice, folder.id, {
      name: 'locked.pdf',
      bytes: encryptedPdf('pw', 'Hidden'),
      mime: 'application/pdf',
    }, 'fail')
    await expect(
      tool('drive.pdf_rotate').handler(as('alice'), {
        file_id: locked.id,
        pages: [1],
        degrees: 90,
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: '“locked.pdf” is password-protected, so its pages can’t be changed.',
    })
    await expect(
      tool('drive.pdf_merge').handler(as('alice'), { file_ids: [file.id] }),
    ).rejects.toThrow()
  })

  it('names page sets compactly', () => {
    expect(pageRangesLabel([5, 2, 3, 4, 9])).toBe('2–5, 9')
    expect(pageRangesLabel([1])).toBe('1')
  })
})
