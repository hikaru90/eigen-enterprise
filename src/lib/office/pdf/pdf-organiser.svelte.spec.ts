import { PDFDocument } from 'pdf-lib/dist/pdf-lib.esm.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockHolder, LockView } from '$lib/drive/api'
import { makePdf } from './fixtures'
import PdfViewer from './pdf-viewer.svelte'
import { loadPdfJs } from './pdfjs'

const api = vi.hoisted(() => {
  class DriveApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string | null,
      readonly holder: unknown,
    ) {
      super(message)
    }
  }
  return {
    DriveApiError,
    readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
    acquireLock: vi.fn<(id: string, session: string, takeover?: boolean) => Promise<LockView>>(),
    heartbeatLock: vi.fn<(id: string, session: string) => Promise<LockView>>(),
    releaseLock: vi.fn<(id: string, session: string) => Promise<void>>(),
    writeBytes:
      vi.fn<(id: string, bytes: Uint8Array, session: string) => Promise<{ file: DriveItem }>>(),
    listFolder: vi.fn(),
    upload:
      vi.fn<
        (
          folderId: string | null,
          files: File[],
        ) => Promise<{ uploaded: DriveItem[]; errors: string[] }>
      >(),
  }
})
vi.mock('$lib/drive/api', () => ({
  DriveApiError: api.DriveApiError,
  driveApi: {
    readBytes: api.readBytes,
    acquireLock: api.acquireLock,
    heartbeatLock: api.heartbeatLock,
    releaseLock: api.releaseLock,
    writeBytes: api.writeBytes,
    listFolder: api.listFolder,
    upload: api.upload,
  },
}))
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }))

const bob: LockHolder = {
  userId: 'bob',
  sessionId: 'tab-bob',
  since: '2026-11-20T10:00:00Z',
  name: 'Bob',
}
const saved = { id: 'f1', type: 'file', name: 'report.pdf' } as DriveItem

function pdfOf(n: number, prefix = 'Page') {
  return makePdf(Array.from({ length: n }, (_, i) => ({ lines: [`${prefix} ${i + 1} heading`] })))
}

/** What a PDF holds, read back with pdf.js: each page's first line and rotation. */
async function readBack(bytes: Uint8Array) {
  const lib = await loadPdfJs()
  const task = lib.getDocument({ data: bytes.slice() })
  const doc = await task.promise
  const out: Array<{ text: string; rotate: number }> = []
  for (let n = 1; n <= doc.numPages; n++) {
    const p = await doc.getPage(n)
    const items = (await p.getTextContent()).items.filter((i) => 'str' in i && i.str.trim())
    out.push({ text: items[0] && 'str' in items[0] ? items[0].str : '', rotate: p.rotate })
  }
  await task.destroy()
  return out
}

let host: HTMLDivElement
beforeEach(async () => {
  vi.clearAllMocks()
  // A desktop window: the grid's tiles all on screen (thumbnails draw as they come into view).
  await page.viewport(1280, 900)
  api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
  api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
  api.releaseLock.mockResolvedValue(undefined)
  api.writeBytes.mockResolvedValue({ file: saved })
  host = document.createElement('div')
  host.style.width = '1100px'
  host.style.height = '760px'
  host.style.display = 'flex'
  host.style.flexDirection = 'column'
  document.body.append(host)
})
afterEach(() => host.remove())

async function openOrganiser(
  bytes: Uint8Array,
  props: { canEdit?: boolean; folderId?: string | null } = {},
) {
  api.readBytes.mockResolvedValue(bytes)
  const onsaved = vi.fn()
  render(PdfViewer, {
    target: host,
    props: {
      fileId: 'f1',
      name: 'report.pdf',
      canEdit: props.canEdit ?? true,
      heartbeatMs: 60_000,
      folderId: 'folderId' in props ? props.folderId : 'folder-1',
      onsaved,
    },
  })
  await expect.element(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  return { onsaved }
}

const tiles = () => page.getByTestId('pdf-org-page')
const tile = (i: number) => tiles().nth(i)
const pagesInOrder = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="pdf-org-page"]')].map((el) =>
    el.dataset.kind === 'blank' ? 'blank' : `${el.dataset.source}:${el.dataset.page}`,
  )

async function enter() {
  await page.getByTestId('pdf-organise').click()
  await expect.element(page.getByTestId('pdf-organiser')).toHaveAttribute('data-lock', 'held')
}

describe('PDF Organise mode', () => {
  it('is offered only with edit access', async () => {
    await openOrganiser(await pdfOf(2), { canEdit: false })
    await expect.element(page.getByTestId('pdf-organise')).not.toBeInTheDocument()
  })

  it('takes the lock, stages rotate / delete / drag-reorder with undo and redo, and saves one revision', async () => {
    const bytes = await pdfOf(4)
    const { onsaved } = await openOrganiser(bytes)
    await enter()
    expect(api.acquireLock).toHaveBeenCalledWith('f1', expect.any(String), false)
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:1', '0:2', '0:3'])
    await expect
      .poll(() => tile(0).element().querySelector('[data-drawn="true"] canvas'))
      .not.toBeNull()

    await tile(0).click()
    await page.getByTestId('pdf-org-rotate-right').click()
    await expect.element(tile(0)).toHaveAttribute('data-turn', '90')

    await tile(1).click()
    await userEvent.keyboard('{Delete}')
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:2', '0:3'])
    await userEvent.keyboard('{Control>}z{/Control}')
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:1', '0:2', '0:3'])
    await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}')
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:2', '0:3'])

    // Drag page 4 onto page 1's right half: right after it.
    await userEvent.dragAndDrop(tile(2), tile(0), { targetPosition: { x: 120, y: 60 } })
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:3', '0:2'])
    // … and back to the front: dropped on page 1's left half.
    await userEvent.dragAndDrop(tile(1), tile(0), { targetPosition: { x: 10, y: 60 } })
    await expect.poll(() => pagesInOrder()).toEqual(['0:3', '0:0', '0:2'])
    await userEvent.keyboard('{Control>}z{/Control}')
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:3', '0:2'])
    await expect.element(page.getByTestId('pdf-org-status')).toHaveTextContent('not saved')

    await page.getByTestId('pdf-org-save').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    const [id, written, session] = api.writeBytes.mock.calls[0]!
    expect(id).toBe('f1')
    expect(session).toBe(api.acquireLock.mock.calls[0]![1])
    expect(await readBack(written)).toEqual([
      { text: 'Page 1 heading', rotate: 90 },
      { text: 'Page 4 heading', rotate: 0 },
      { text: 'Page 3 heading', rotate: 0 },
    ])
    expect(api.releaseLock).toHaveBeenCalled()
    expect(onsaved).toHaveBeenCalledWith(saved)
    await expect
      .element(page.getByTestId('pdf-organise-notice'))
      .toHaveTextContent('Saved the pages')
    await expect.element(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
    await expect.poll(() => document.querySelectorAll('[data-testid="pdf-page"]').length).toBe(3)
  })

  it('selects with Shift (range) and ⌘/Ctrl (add); Alt+arrow moves the selection', async () => {
    await openOrganiser(await pdfOf(5))
    await enter()
    await tile(1).click()
    await tile(3).click({ modifiers: ['Shift'] })
    const selected = () =>
      [...document.querySelectorAll('[data-testid="pdf-org-page"][aria-selected="true"]')].length
    expect(selected()).toBe(3)
    await tile(0).click({ modifiers: ['ControlOrMeta'] })
    expect(selected()).toBe(4)
    await expect.element(page.getByTestId('pdf-org-status')).toHaveTextContent('4 of 5 selected')
    await tile(4).click()
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}')
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:1', '0:2', '0:4', '0:3'])
  })

  it('inserts a blank page and the pages of another Drive PDF after the selection', async () => {
    const other = await pdfOf(2, 'Appendix')
    await openOrganiser(await pdfOf(2))
    await enter()
    await tile(0).click()
    await page.getByTestId('pdf-org-insert-blank').click()
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', 'blank', '0:1'])

    api.listFolder.mockResolvedValue({
      folder: null,
      path: [],
      canEdit: true,
      items: [
        { type: 'folder', id: 'd1', name: 'Archive' },
        { type: 'file', id: 'f1', name: 'report.pdf', mime: 'application/pdf' },
        { type: 'file', id: 'f2', name: 'appendix.pdf', mime: 'application/pdf' },
        { type: 'file', id: 'f3', name: 'notes.md', mime: 'text/markdown' },
      ],
    })
    api.readBytes.mockImplementation(async (id) =>
      id === 'f2' ? other : api.readBytes.mock.results[0]!.value,
    )
    await page.getByTestId('pdf-org-insert-pdf').click()
    const picker = page.getByTestId('pdf-picker')
    await expect.element(picker).toBeVisible()
    const files = page.getByTestId('pdf-picker-file')
    await expect.element(files.first()).toHaveTextContent('appendix.pdf')
    expect(files.elements()).toHaveLength(1)
    await files.first().click()
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', 'blank', '1:0', '1:1', '0:1'])
    await expect.element(tile(2)).toHaveAccessibleName('Page 3, from appendix.pdf')

    await page.getByTestId('pdf-org-save').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    const back = await readBack(api.writeBytes.mock.calls[0]![1])
    expect(back.map((p) => p.text)).toEqual([
      'Page 1 heading',
      '',
      'Appendix 1 heading',
      'Appendix 2 heading',
      'Page 2 heading',
    ])
  })

  it('extracts the selected pages as a new file next to this one', async () => {
    await openOrganiser(await pdfOf(4))
    api.upload.mockImplementation(async (_folder, files) => ({
      uploaded: [{ type: 'file', id: 'new1', name: files[0]!.name } as DriveItem],
      errors: [],
    }))
    await enter()
    await tile(1).click()
    await tile(2).click({ modifiers: ['Shift'] })
    await page.getByTestId('pdf-org-extract').click()
    await expect
      .element(page.getByTestId('pdf-org-notice'))
      .toHaveTextContent('Saved the 2 pages as “report (pages 2–3).pdf” next to this file.')
    const [folder, files] = api.upload.mock.calls[0]!
    expect(folder).toBe('folder-1')
    expect(files[0]!.name).toBe('report (pages 2–3).pdf')
    expect(files[0]!.type).toBe('application/pdf')
    const doc = await PDFDocument.load(new Uint8Array(await files[0]!.arrayBuffer()))
    expect(doc.getPageCount()).toBe(2)
    expect(page.getByRole('link', { name: 'Open it' }).element().getAttribute('href')).toBe(
      '/drive/file/new1',
    )
    // Extracting changes nothing in this file.
    expect(api.writeBytes).not.toHaveBeenCalled()
  })

  it('splits each run of the selection into its own file next to this one', async () => {
    await openOrganiser(await pdfOf(7))
    api.upload.mockImplementation(async (_folder, files) => ({
      uploaded: files.map((f) => ({ type: 'file', id: `n-${f.name}`, name: f.name }) as DriveItem),
      errors: [],
    }))
    await enter()
    await tile(1).click()
    await tile(2).click({ modifiers: ['Shift'] })
    await tile(6).click({ modifiers: ['ControlOrMeta'] })
    await page.getByTestId('pdf-org-split').click()
    await expect
      .element(page.getByTestId('pdf-org-notice'))
      .toHaveTextContent('Split 3 pages into 2 files next to this one')
    await expect
      .element(page.getByTestId('pdf-org-notice'))
      .toHaveTextContent('“report (pages 2–3).pdf”, “report (page 7).pdf”')
    expect(api.upload).toHaveBeenCalledTimes(1)
    const [folder, files] = api.upload.mock.calls[0]!
    expect(folder).toBe('folder-1')
    expect(files.map((f) => f.name)).toEqual(['report (pages 2–3).pdf', 'report (page 7).pdf'])
    expect(files.map((f) => f.type)).toEqual(['application/pdf', 'application/pdf'])
    for (const f of files) {
      const doc = await PDFDocument.load(new Uint8Array(await f.arrayBuffer()))
      expect(doc.getPageCount()).toBe(f === files[0] ? 2 : 1)
    }
    expect(page.getByRole('link', { name: 'Open the folder' }).element().getAttribute('href')).toBe(
      '/drive/folder/folder-1',
    )
    // Splitting changes nothing in this file.
    expect(api.writeBytes).not.toHaveBeenCalled()
  })

  it('without the file’s folder there is no Extract or Split (the page did not say where)', async () => {
    await openOrganiser(await pdfOf(2), { folderId: undefined })
    await enter()
    await expect.element(page.getByTestId('pdf-org-extract')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('pdf-org-split')).not.toBeInTheDocument()
  })

  it('shows who is editing and takes over on request', async () => {
    api.acquireLock.mockResolvedValueOnce({ state: 'locked', holder: bob })
    await openOrganiser(await pdfOf(2))
    await page.getByTestId('pdf-organise').click()
    await expect.element(page.getByTestId('pdf-org-lock-holder')).toHaveTextContent('Bob')
    await expect.element(page.getByTestId('pdf-org-save')).toBeDisabled()
    await expect.element(page.getByTestId('pdf-org-rotate-right')).toBeDisabled()
    await page.getByTestId('pdf-org-takeover').click()
    await expect.element(page.getByTestId('pdf-organiser')).toHaveAttribute('data-lock', 'held')
    expect(api.acquireLock).toHaveBeenLastCalledWith('f1', expect.any(String), true)
  })

  it('a taken-over session keeps the staged pages on screen and says so', async () => {
    await openOrganiser(await pdfOf(3))
    await enter()
    await tile(2).click()
    await userEvent.keyboard('{Delete}')
    api.writeBytes.mockRejectedValue(
      new api.DriveApiError(
        'Bob took over editing; your changes were not saved.',
        409,
        'locked',
        bob,
      ),
    )
    await page.getByTestId('pdf-org-save').click()
    await expect
      .element(page.getByTestId('pdf-org-lost-banner'))
      .toHaveTextContent('Bob took over editing')
    await expect
      .element(page.getByTestId('pdf-org-lost-banner'))
      .toHaveTextContent('they are still here')
    expect(pagesInOrder()).toEqual(['0:0', '0:1'])
    await expect.element(page.getByTestId('pdf-org-save')).toBeDisabled()
  })

  it('Discard leaves without saving and lets the lock go', async () => {
    await openOrganiser(await pdfOf(3))
    await enter()
    await tile(0).click()
    await userEvent.keyboard('{Delete}')
    await page.getByTestId('pdf-org-discard').click()
    await expect.element(page.getByTestId('pdf-organiser')).not.toBeInTheDocument()
    expect(api.releaseLock).toHaveBeenCalled()
    expect(api.writeBytes).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-testid="pdf-page"]')).toHaveLength(3)
  })

  it('a file changed since it was opened is shown fresh before anything is staged', async () => {
    const first = await pdfOf(2)
    const newer = await pdfOf(5)
    await openOrganiser(first)
    api.readBytes.mockResolvedValue(newer)
    await page.getByTestId('pdf-organise').click()
    await expect.poll(() => pagesInOrder()).toEqual(['0:0', '0:1', '0:2', '0:3', '0:4'])
    await expect.element(page.getByTestId('pdf-organiser')).toHaveAttribute('data-lock', 'held')
  })
})
