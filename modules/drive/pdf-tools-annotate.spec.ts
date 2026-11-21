import type { Actor } from './service'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { delegatedPrincipal } from '$lib/kernel/principals'
import { makeFormPdf, makePdf } from '$lib/office/pdf/fixtures'
import { readPdfContents } from '$lib/office/pdf/edit'
import { memoryEditLockStore } from './locks'
import { DRIVE_PDF_ANNOTATE_TOOL_NAMES, DRIVE_TOOL_NAMES } from './manifest'
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

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'drive-pdf-annotate-'))
  dirs.push(dir)
  const access = memoryDriveAccess({
    users: {
      alice: { role: 'member', name: 'Alice Example' },
      bob: { role: 'member', name: 'Bob' },
    },
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
  const upload = async (bytes: Uint8Array, name = 'report.pdf') =>
    drive.upload(alice, folder.id, { name, bytes, mime: 'application/pdf' })
  const contents = async (id: string) =>
    readPdfContents({ bytes: (await drive.readFile(alice, id)).bytes })
  return { drive, tool, as, folder, upload, contents }
}

describe('drive.pdf_* annotation, form and property tools', () => {
  it('are registered Drive tools: the lists read, the rest write with approval risk internal', async () => {
    const { tool } = await setup()
    for (const name of DRIVE_PDF_ANNOTATE_TOOL_NAMES) {
      expect(DRIVE_TOOL_NAMES).toContain(name)
      const t = tool(name)
      expect(t.module).toBe('drive')
      if (name.includes('_list_')) expect(t.auditClass).toBe('read')
      else expect(t).toMatchObject({ auditClass: 'mutate', approvalRisk: 'internal' })
    }
    expect(
      tool('drive.pdf_add_note').activity!(
        { file_id: 'f', page: 2 },
        { file: { name: 'report.pdf' } },
      ),
    ).toBe('Added a note on page 2 of report.pdf in Drive')
    expect(
      tool('drive.pdf_fill_form').activity!(
        { file_id: 'f', values: { a: 'b' }, flatten: true },
        { file: { name: 'form.pdf' } },
      ),
    ).toBe('Filled 1 form field of form.pdf and flattened the form in Drive')
  })

  it('adds a note signed by the acting member, lists it in page coordinates, and replies to it', async () => {
    const { drive, tool, as, upload, folder } = await setup()
    const file = await upload(await makePdf([{ lines: ['One'] }, { lines: ['Two'] }]))
    const added = (await tool('drive.pdf_add_note').handler(as('alice'), {
      file_id: file.id,
      page: 2,
      x: 100,
      y: 50,
      text: 'Look here',
    })) as { annotation_id: string }
    expect(await drive.listRevisions(alice, file.id)).toHaveLength(2)
    await drive.setGrants(alice, 'folder', folder.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'edit' },
    ])
    await tool('drive.pdf_reply').handler(as('bob'), {
      file_id: file.id,
      annotation_id: added.annotation_id,
      text: 'Seen',
    })
    const listed = (await tool('drive.pdf_list_annotations').handler(as('alice'), {
      file_id: file.id,
      page: 2,
    })) as {
      pages: unknown[]
      annotations: Array<Record<string, unknown>>
    }
    expect(listed.pages).toEqual([
      { page: 1, width: 612, height: 792, rotate: 0 },
      { page: 2, width: 612, height: 792, rotate: 0 },
    ])
    expect(listed.annotations).toEqual([
      expect.objectContaining({
        id: added.annotation_id,
        page: 2,
        kind: 'Text',
        x: 100,
        y: 50,
        width: 20,
        height: 20,
        author: 'Alice Example',
        text: 'Look here',
        color: '#ffd400',
        in_reply_to: null,
      }),
      expect.objectContaining({
        page: 2,
        kind: 'Text',
        author: 'Bob',
        text: 'Seen',
        in_reply_to: added.annotation_id,
      }),
    ])
    await expect(
      tool('drive.pdf_add_note').handler(as('alice'), {
        file_id: file.id,
        page: 3,
        x: 1,
        y: 1,
        text: 'x',
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'There is no page 3; the PDF has 2 pages.',
    })
    await expect(
      tool('drive.pdf_add_note').handler(as('alice'), {
        file_id: file.id,
        page: 1,
        x: 700,
        y: 1,
        text: 'x',
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('outside it'),
    })
    await expect(
      tool('drive.pdf_reply').handler(as('alice'), {
        file_id: file.id,
        annotation_id: '999R',
        text: 'x',
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'There is no annotation 999R in this PDF.',
    })
  })

  it('edits annotations: add any kind, move, recolour, review, delete — one revision per call', async () => {
    const { drive, tool, as, upload, contents } = await setup()
    const file = await upload(await makePdf([{ lines: ['One'] }]))
    const out = (await tool('drive.pdf_edit_annotations').handler(as('alice'), {
      file_id: file.id,
      edits: [
        {
          op: 'add',
          page: 1,
          annotation: {
            kind: 'Highlight',
            boxes: [{ x: 72, y: 60, width: 100, height: 14 }],
            color: '#ffff00',
            opacity: 0.5,
          },
        },
        {
          op: 'add',
          page: 1,
          annotation: {
            kind: 'Line',
            from: { x: 100, y: 300 },
            to: { x: 200, y: 300 },
            color: '#ff0000',
            arrow: 'both',
          },
        },
        {
          op: 'add',
          page: 1,
          annotation: {
            kind: 'FreeText',
            box: { x: 300, y: 100, width: 150, height: 40 },
            color: '#000000',
            text: 'Box',
          },
        },
      ],
    })) as { added: Array<{ edit: number; id: string }> }
    expect(out.added.map((a) => a.edit)).toEqual([1, 2, 3])
    const [hl, line] = out.added
    expect(
      (await contents(file.id)).annotations.find((a) => a.id === line!.id)!.shape,
    ).toMatchObject({ line: [100, 492, 200, 492], ends: ['OpenArrow', 'OpenArrow'] })
    await tool('drive.pdf_edit_annotations').handler(as('alice'), {
      file_id: file.id,
      edits: [
        { op: 'update', id: hl!.id, color: '#00ff00', move: { dx: 10, dy: 10 } },
        { op: 'review', id: hl!.id, state: 'Accepted' },
        { op: 'delete', id: line!.id },
      ],
    })
    const after = (await contents(file.id)).annotations
    expect(after.map((a) => a.kind).sort()).toEqual(['FreeText', 'Highlight'])
    const moved = after.find((a) => a.id === hl!.id)!
    expect(moved).toMatchObject({
      color: [0, 1, 0],
      review: { state: 'Accepted', author: 'Alice Example' },
    })
    expect(moved.rect.map(Math.round)).toEqual([81, 707, 183, 723])
    expect(await drive.listRevisions(alice, file.id)).toHaveLength(3)
  })

  it('lists and fills form fields, honouring the field rules', async () => {
    const { tool, as, upload } = await setup()
    const file = await upload(await makeFormPdf(), 'form.pdf')
    const listed = (await tool('drive.pdf_list_form_fields').handler(as('alice'), {
      file_id: file.id,
    })) as {
      kind: string
      fields: Array<{ name: string; type: string; pages: number[] }>
    }
    expect(listed.kind).toBe('acroform')
    expect(listed.fields.find((f) => f.name === 'size')).toMatchObject({
      type: 'radio',
      pages: [1],
    })
    const filled = (await tool('drive.pdf_fill_form').handler(as('alice'), {
      file_id: file.id,
      values: { agree: true },
    })) as { warnings: string[] }
    expect(filled.warnings).toEqual(['Required fields still empty: “name”.'])
    await tool('drive.pdf_fill_form').handler(as('alice'), {
      file_id: file.id,
      values: { name: 'Ada', size: 'L' },
    })
    const again = (await tool('drive.pdf_list_form_fields').handler(as('alice'), {
      file_id: file.id,
    })) as {
      fields: Array<{ name: string; value: unknown }>
    }
    expect(Object.fromEntries(again.fields.map((f) => [f.name, f.value]))).toMatchObject({
      name: 'Ada',
      size: 'L',
      agree: true,
    })
    await expect(
      tool('drive.pdf_fill_form').handler(as('alice'), {
        file_id: file.id,
        values: { locked: 'x' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: '“locked” is read-only.',
    })
    const xfa = await upload(await makeFormPdf({ xfaOnly: true }), 'xfa.pdf')
    expect(
      await tool('drive.pdf_list_form_fields').handler(as('alice'), { file_id: xfa.id }),
    ).toMatchObject({
      kind: 'xfa-only',
      note: expect.stringContaining('can’t be filled here'),
    })
  })

  it('sets document properties', async () => {
    const { tool, as, upload, contents } = await setup()
    const file = await upload(await makePdf([{ lines: ['x'] }], { title: 'Old' }))
    await tool('drive.pdf_set_properties').handler(as('alice'), {
      file_id: file.id,
      title: 'New',
      keywords: 'a, b',
    })
    expect((await contents(file.id)).properties).toMatchObject({ title: 'New', keywords: 'a, b' })
    await expect(
      tool('drive.pdf_set_properties').handler(as('alice'), { file_id: file.id }),
    ).rejects.toThrow()
  })

  it('is access-checked as the caller and never writes an anonymous note', async () => {
    const { drive, tool, as, upload, folder } = await setup()
    const file = await upload(await makePdf([{ lines: ['x'] }]))
    await expect(
      tool('drive.pdf_list_annotations').handler(as('bob'), { file_id: file.id }),
    ).rejects.toMatchObject({ code: 'not_found' })
    await drive.setGrants(alice, 'folder', folder.id, [
      { subject: { kind: 'user', userId: 'alice' }, level: 'manage' },
      { subject: { kind: 'user', userId: 'bob' }, level: 'view' },
    ])
    await expect(
      tool('drive.pdf_add_note').handler(as('bob'), {
        file_id: file.id,
        page: 1,
        x: 1,
        y: 1,
        text: 'x',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      tool('drive.pdf_add_note').handler(
        { principal: { id: 'bot', kind: 'agent', roles: ['agent'] }, requestId: 'r' },
        { file_id: file.id, page: 1, x: 1, y: 1, text: 'x' },
      ),
    ).rejects.toMatchObject({ code: expect.any(String) })
    expect(await drive.listRevisions(alice, file.id)).toHaveLength(1)
    const notes = await drive.createDocument(alice, folder.id, 'md', 'notes', '# hi')
    await expect(
      tool('drive.pdf_list_annotations').handler(as('alice'), { file_id: notes.id }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: '“notes.md” is not a PDF.',
    })
  })
})
