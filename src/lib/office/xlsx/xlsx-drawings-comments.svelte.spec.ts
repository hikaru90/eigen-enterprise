import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView, ShareTargets } from '$lib/drive/api'
import { anchorBox, readDrawing, sheetGeometry } from './drawing'
import { readNotes } from './notes'
import { budgetBook, buildXlsx, row } from './test-utils/build-xlsx'
import { commentBook, pictureBook, png } from './test-utils/drawing-fixtures'
import { readPersons, readThreads } from './threads'
import { openWorkbook } from './workbook'
import { resetPlainLive } from './test-utils/live-api'
import XlsxEditor from './xlsx-editor.svelte'

/** End-to-end browser checks for XLSX pictures, shapes, text boxes, in-cell images, legacy notes and threaded comments. */

const api = vi.hoisted(() => ({
  readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
  acquireLock: vi.fn<(id: string, session: string, takeover?: boolean) => Promise<LockView>>(),
  heartbeatLock: vi.fn<(id: string, session: string) => Promise<LockView>>(),
  releaseLock: vi.fn<(id: string, session: string) => Promise<void>>(),
  writeBytes:
    vi.fn<
      (
        id: string,
        bytes: Uint8Array,
        session: string,
        base?: string,
      ) => Promise<{ file: DriveItem }>
    >(),
  listFolder: vi.fn<(id: string | null) => Promise<{ path: Array<{ id: string; name: string }>; items: DriveItem[] }>>(),
  shareTargets: vi.fn<() => Promise<ShareTargets>>(),
}))

vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  const { liveOverPlainApi } = await import('./test-utils/live-api')
  return { ...real, driveApi: { ...real.driveApi, ...api, ...liveOverPlainApi(api) } }
})

const props = {
  fileId: 'book-1',
  name: 'Workbook.xlsx',
  canEdit: true,
  heartbeatMs: 600_000,
  saveDelayMs: 20,
  idleMs: 600_000,
  author: { id: 'u-ada', name: 'Ada Lovelace' },
}

const savedBook = () => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openWorkbook(calls.at(-1)![1])
}

const cell = (ref: string) =>
  document.querySelector(`[data-testid="xlsx-grid"] [data-ref="${ref}"]`) as HTMLElement | null

const drawingEl = (id: string) =>
  document.querySelector(`[data-testid="xlsx-drawing-item"][data-drawing-id="${id}"]`) as HTMLElement | null

function richCellImageBook(): Uint8Array {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
  const base = unzipSync(
    buildXlsx({
      sheets: [{ name: 'Cells', rows: row(2, '<c r="B2" t="e" vm="1"><v>#VALUE!</v></c>') }],
      workbookRels: [
        { type: 'sheetMetadata', target: 'metadata.xml' },
        { type: 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue', target: 'richData/rdRichValue.xml' },
        { type: 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure', target: 'richData/rdRichValueStructure.xml' },
        { type: 'http://schemas.microsoft.com/office/2022/10/relationships/richValueRel', target: 'richData/richValueRel.xml' },
      ],
      parts: {
        '/xl/metadata.xml': {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
          xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xlrd="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata"><metadataTypes count="1"><metadataType name="XLRICHVALUE" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1"/></metadataTypes><futureMetadata name="XLRICHVALUE" count="1"><bk><extLst><ext uri="{3E2802C4-A4D2-4D8B-9148-E3BE6C30E623}"><xlrd:rvb i="0"/></ext></extLst></bk></futureMetadata><valueMetadata count="1"><bk><rc t="1" v="0"/></bk></valueMetadata></metadata>`,
        },
        '/xl/richData/rdRichValueStructure.xml': {
          type: 'application/vnd.ms-excel.rdrichvaluestructure+xml',
          xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rvStructures xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2" count="1"><s t="_localImage"><k n="_rvRel:LocalImageIdentifier" t="i"/><k n="CalcOrigin" t="i"/><k n="Text" t="s"/></s></rvStructures>`,
        },
        '/xl/richData/rdRichValue.xml': {
          type: 'application/vnd.ms-excel.rdrichvalue+xml',
          xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><rvData xmlns="http://schemas.microsoft.com/office/spreadsheetml/2017/richdata" count="1"><rv s="0"><v>0</v><v>5</v><v>In-cell icon</v></rv></rvData>`,
        },
        '/xl/richData/richValueRel.xml': {
          type: 'application/vnd.ms-excel.richvaluerel+xml',
          xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><richValueRels xmlns="http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><rel r:id="rId1"/></richValueRels>`,
        },
      },
    }),
  )
  base['[Content_Types].xml'] = strToU8(
    strFromU8(base['[Content_Types].xml']!).replace(
      '<Default Extension="xml"',
      '<Default Extension="png" ContentType="image/png"/><Default Extension="xml"',
    ),
  )
  return zipSync({
    ...base,
    'xl/media/cell1.png': png(24, 24),
    'xl/richData/_rels/richValueRel.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}image" Target="../media/cell1.png"/></Relationships>`,
    ),
  })
}

describe('xlsx editor: drawings, cell images, notes and threaded comments', () => {
  let activeBytes: Uint8Array = budgetBook()

  beforeEach(() => {

    resetPlainLive(api)
    for (const fn of Object.values(api)) fn.mockReset()
    activeBytes = budgetBook()
    api.readBytes.mockImplementation(async (id) => {
      if (id === 'img-drive-1') return png(96, 48)
      return api.writeBytes.mock.calls.at(-1)?.[1] ?? activeBytes
    })
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-25T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({
      file: { id: 'book-1', type: 'file', name: 'Workbook.xlsx' } as DriveItem,
    }))
    api.listFolder.mockResolvedValue({
      path: [],
      items: [
        {
          type: 'file',
          id: 'img-drive-1',
          name: 'logo.png',
          mime: 'image/png',
          parentId: null,
          ownerId: 'u-ada',
          updatedAt: '2026-11-25T10:00:00Z',
          trashedAt: null,
        },
      ],
    })
    api.shareTargets.mockResolvedValue({
      people: [
        { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com' },
        { id: 'u-bob', name: 'Bob Builder', email: 'bob@example.com' },
      ],
      groups: [],
    })
  })

  it('renders existing pictures, shapes, text boxes, charts, groups and in-cell images', async () => {
    activeBytes = pictureBook()
    render(XlsxEditor, props)

    await expect.element(page.getByTestId('xlsx-drawing-layer')).toBeInTheDocument()
    await expect.poll(() => drawingEl('2')).not.toBeNull()
    expect(drawingEl('2')!.style.transform).toContain('rotate(90deg)')
    expect(drawingEl('2')!.querySelector('img')).not.toBeNull()
    expect(drawingEl('3')!.textContent).toContain('Q3 target')
    expect(drawingEl('4')!.textContent).toContain('Note to self')
    // The chart frame is drawn by the charts code in the same layer (frame snippet), as chart1.
    const chartFrame = document.querySelector('[data-testid="xlsx-chart-frame"][data-drawing-id="5"]')
    expect(chartFrame?.getAttribute('data-chart-id')).toBe('chart1')
    expect(drawingEl('6')!.getAttribute('data-drawing-kind')).toBe('group')
  })

  it('shows Excel 365 pictures placed in cells inside their cell', async () => {
    activeBytes = richCellImageBook()
    render(XlsxEditor, { ...props, fileId: 'rich-1' })
    await expect
      .poll(() => document.querySelector('[data-testid="xlsx-cell-image"]')?.getAttribute('alt'))
      .toBe('In-cell icon')
    expect(document.querySelector('[data-testid="xlsx-cell-image"]')!.closest('[data-ref]')?.getAttribute('data-ref')).toBe('B2')
  })

  it('inserts pictures from file and Drive, shapes and text boxes; drags to move, resizes, updates properties, deletes and undoes', async () => {
    render(XlsxEditor, props)
    await expect.poll(() => cell('B2')).not.toBeNull()
    await userEvent.click(cell('B2')!)

    // Upload image from local file
    const fileInput = page.getByTestId('xlsx-picture-input').element() as HTMLInputElement
    const file = new File([png(80, 40)], 'badge.png', { type: 'image/png' })
    const dt = new DataTransfer()
    dt.items.add(file)
    Object.defineProperty(fileInput, 'files', { value: dt.files, configurable: true })
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))

    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-drawing-item"]').length).toBe(1)
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThanOrEqual(1)

    // Edit alt text on selected picture
    const altInput = page.getByTestId('xlsx-drawing-alt')
    await userEvent.fill(altInput, 'Company emblem')
    await userEvent.keyboard('{Tab}')
    await expect.poll(() => {
      const wb = savedBook()
      return readDrawing(wb, wb.requireWorksheet('Budget'))[0]?.alt
    }).toBe('Company emblem')

    // Insert image from Drive via picker
    await userEvent.click(page.getByTestId('xlsx-insert-picture-drive'))
    await expect.element(page.getByTestId('xlsx-image-picker')).toBeInTheDocument()
    await userEvent.click(page.getByTestId('xlsx-image-picker-file'))
    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-drawing-item"]').length).toBe(2)

    // Create a rounded rectangle shape, drag to move it, and resize it via SE handle
    await userEvent.selectOptions(page.getByTestId('xlsx-insert-shape'), 'roundRect')
    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-drawing-item"]').length).toBe(3)
    const shapeItem = document.querySelector('[data-testid="xlsx-drawing-item"][data-drawing-kind="shape"]')! as HTMLElement
    const shapeId = shapeItem.getAttribute('data-drawing-id')!

    const rect1 = shapeItem.getBoundingClientRect()
    const sx = rect1.left + rect1.width / 2
    const sy = rect1.top + rect1.height / 2
    shapeItem.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, button: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: sx + 45, clientY: sy + 25 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: sx + 45, clientY: sy + 25 }))

    await expect.poll(() => {
      const wb = savedBook()
      const info = wb.requireWorksheet('Budget')
      const g = sheetGeometry(wb.sheet('Budget'))
      const d = readDrawing(wb, info, g).find((o) => o.id === shapeId)
      return d?.anchor ? Math.round(anchorBox(d.anchor, g).x) : 0
    }).toBeGreaterThan(80)

    const handle = page.getByTestId('xlsx-drawing-handle-se').element()
    const hRect = handle.getBoundingClientRect()
    const hx = hRect.left + 2
    const hy = hRect.top + 2
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: hx, clientY: hy, button: 0, bubbles: true }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: hx + 40, clientY: hy + 20 }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: hx + 40, clientY: hy + 20 }))

    await expect.poll(() => {
      const wb = savedBook()
      const info = wb.requireWorksheet('Budget')
      const g = sheetGeometry(wb.sheet('Budget'))
      const d = readDrawing(wb, info, g).find((o) => o.id === shapeId)
      return d?.anchor ? Math.round(anchorBox(d.anchor, g).w) : 0
    }).toBeGreaterThan(190)

    // Update shape text, delete it, then undo to bring it back
    await userEvent.fill(page.getByTestId('xlsx-drawing-text'), 'Target met')
    await userEvent.keyboard('{Tab}')
    await expect.poll(() => shapeItem.textContent).toContain('Target met')

    await userEvent.click(page.getByTestId('xlsx-drawing-delete'))
    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-drawing-item"]').length).toBe(2)

    await userEvent.click(page.getByTestId('xlsx-undo'))
    await expect.poll(() => document.querySelectorAll('[data-testid="xlsx-drawing-item"]').length).toBe(3)
  })

  it('shows red note corners & purple comment badges with hover preview, and supports note/comment add, @mentions, reply, edit, resolve and delete', async () => {
    activeBytes = commentBook()
    render(XlsxEditor, props)

    // Visible note on B2 and red/purple indicators
    await expect.element(page.getByTestId('xlsx-visible-note')).toBeInTheDocument()
    await expect.poll(() => cell('B2')?.querySelector('[data-testid="xlsx-note-indicator"]')).not.toBeNull()
    await expect.poll(() => cell('C4')?.querySelector('[data-testid="xlsx-comment-indicator"]')).not.toBeNull()

    // Hovering C4 shows the threaded comment preview popover
    cell('C4')!.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await expect.element(page.getByTestId('xlsx-annotation-popover')).toHaveTextContent('Is this final?')
    cell('C4')!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))

    // Open the Comments & Notes panel, toggle B2 Show Note off, and edit B2 note
    await userEvent.click(page.getByTestId('xlsx-comments-toggle'))
    await expect.element(page.getByTestId('xlsx-comments-panel')).toBeInTheDocument()

    await userEvent.click(page.getByTestId('xlsx-note-visible-toggle'))
    await expect.poll(() => document.querySelector('[data-testid="xlsx-visible-note"]')).toBeNull()

    await userEvent.click(page.getByTestId('xlsx-note-edit-btn'))
    await userEvent.fill(page.getByTestId('xlsx-comment-input'), 'Verified number')
    await userEvent.click(page.getByTestId('xlsx-comment-submit'))
    await expect.poll(() => readNotes(savedBook(), savedBook().requireWorksheet('Notes'))[0]?.text).toBe(
      'Verified number',
    )

    // Select cell D2, add a threaded comment with @Bob Builder mention, reply, resolve and reopen
    await userEvent.click(cell('D2')!)
    await userEvent.click(page.getByTestId('xlsx-new-comment-btn'))
    await userEvent.fill(page.getByTestId('xlsx-comment-input'), 'Review this @Bob')
    await expect.element(page.getByTestId('xlsx-mention-option')).toBeInTheDocument()
    await userEvent.click(page.getByTestId('xlsx-mention-option'))
    await userEvent.click(page.getByTestId('xlsx-comment-submit'))

    await expect.poll(() => {
      const wb = savedBook()
      return readThreads(wb, wb.requireWorksheet('Notes')).some(
        (t) => t.ref === 'D2' && t.comments[0]?.mentions.some((x) => x.memberId === 'u-bob'),
      )
    }).toBe(true)

    const persons = readPersons(savedBook())
    expect(persons.find((p) => p.userId === 'u-bob')).toMatchObject({
      name: 'Bob Builder',
      providerId: 'None',
    })

    // Resolve D2 thread, verify status, then delete C4 root thread
    const d2Card = document.querySelector('[data-testid="xlsx-thread-card"][data-ref="D2"]')!
    await userEvent.click(d2Card.querySelector('[data-testid="xlsx-thread-resolve"]')!)
    await expect.poll(() => d2Card.getAttribute('data-resolved')).toBe('true')

    const c4Card = document.querySelector('[data-testid="xlsx-thread-card"][data-ref="C4"]')!
    await userEvent.click(c4Card.querySelector('[data-testid="xlsx-thread-reply-btn"]')!)
    await userEvent.fill(page.getByTestId('xlsx-comment-input'), 'My follow-up')
    await userEvent.click(page.getByTestId('xlsx-comment-submit'))

    await expect.poll(() => {
      const wb = savedBook()
      return readThreads(wb, wb.requireWorksheet('Notes')).find((t) => t.ref === 'C4')?.comments.length
    }).toBe(3)

    // Edit own follow-up reply, then delete that reply
    const c4Replies = c4Card.querySelectorAll('[data-testid="xlsx-thread-comment"]')
    const myReply = c4Replies[2]!
    await userEvent.click(myReply.querySelector('[data-testid="xlsx-comment-edit-btn"]')!)
    await userEvent.fill(page.getByTestId('xlsx-comment-input'), 'Edited follow-up')
    await userEvent.click(page.getByTestId('xlsx-comment-submit'))
    await expect.poll(() => c4Card.textContent).toContain('Edited follow-up')

    await userEvent.click(c4Card.querySelectorAll('[data-testid="xlsx-comment-delete-btn"]')[1]!)
    await expect.poll(() => {
      const wb = savedBook()
      return readThreads(wb, wb.requireWorksheet('Notes')).find((t) => t.ref === 'C4')?.comments.length
    }).toBe(2)
  })
})
