import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockHolder, LockView } from '$lib/drive/api'
import { readPdfContents } from './edit'
import { makeFormPdf, makePdf } from './fixtures'
import PdfViewer from './pdf-viewer.svelte'

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
const alice = { id: 'alice', name: 'Alice Example' }

let host: HTMLDivElement
beforeEach(async () => {
  vi.clearAllMocks()
  await page.viewport(1280, 900)
  api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
  api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
  api.releaseLock.mockResolvedValue(undefined)
  api.writeBytes.mockResolvedValue({ file: saved })
  host = document.createElement('div')
  host.style.width = '1200px'
  host.style.height = '820px'
  host.style.display = 'flex'
  host.style.flexDirection = 'column'
  document.body.append(host)
})
afterEach(() => host.remove())

async function open(
  bytes: Uint8Array,
  props: { canEdit?: boolean; author?: { id: string; name: string } | undefined } = {},
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
      folderId: 'folder-1',
      author: 'author' in props ? props.author : alice,
      onsaved,
    },
  })
  await expect.element(page.getByTestId('pdf-viewer')).toHaveAttribute('data-status', 'ready')
  return { onsaved }
}

async function enter() {
  await page.getByTestId('pdf-annotate').click()
  await expect.element(page.getByTestId('pdf-editor')).toHaveAttribute('data-lock', 'held')
  await expect.element(page.getByTestId('pdf-editor')).toHaveAttribute('data-ready', 'true')
  await expect.poll(() => pageEl(0)?.dataset.drawn).toBe('true')
}

const pageEl = (i: number) =>
  document.querySelector<HTMLElement>(`[data-testid="pdf-edit-page"][data-page="${i}"]`)

async function saveAndRead() {
  await page.getByTestId('pdf-edit-save').click()
  await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
  const [id, written, session] = api.writeBytes.mock.calls[0]!
  expect(id).toBe('f1')
  expect(session).toBe(api.acquireLock.mock.calls[0]![1])
  return readPdfContents({ bytes: written })
}

/** Selects the text of the page's first text span, as a person dragging over it would. */
function selectFirstLine(i: number) {
  const span = pageEl(i)!.querySelector('.textLayer span')!
  const range = document.createRange()
  range.selectNodeContents(span)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  pageEl(i)!
    .querySelector('.pdf-edit-text')!
    .dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
}

describe('PDF Annotate & fill', () => {
  it('is offered only with edit access', async () => {
    await open(await makePdf([{ lines: ['x'] }]), { canEdit: false })
    await expect.element(page.getByTestId('pdf-annotate')).not.toBeInTheDocument()
  })

  it('adds a note signed by the member, lists it in the comments, and saves one revision', async () => {
    const { onsaved } = await open(await makePdf([{ lines: ['First line of text'] }]))
    await enter()
    await page.getByTestId('pdf-tool-Text').click()
    await page.getByTestId('pdf-edit-surface').click({ position: { x: 400, y: 120 } })
    await page.getByRole('textbox', { name: 'Note text' }).fill('Please check')
    await page.getByTestId('pdf-edit-draft-add').click()
    await expect.element(page.getByTestId('pdf-comment')).toHaveTextContent('Please check')
    await expect.element(page.getByTestId('pdf-comment')).toHaveTextContent('Alice Example')
    await expect.element(page.getByTestId('pdf-edit-status')).toHaveTextContent('not saved')
    const read = await saveAndRead()
    expect(read.annotations).toEqual([
      expect.objectContaining({
        kind: 'Text',
        author: 'Alice Example',
        contents: 'Please check',
        page: 0,
      }),
    ])
    expect(api.releaseLock).toHaveBeenCalled()
    expect(onsaved).toHaveBeenCalledWith(saved)
    await expect
      .element(page.getByTestId('pdf-organise-notice'))
      .toHaveTextContent('Saved the changes')
  })

  it('highlights selected text, with undo and redo, then replies and marks it reviewed', async () => {
    await open(await makePdf([{ lines: ['Highlight this line'] }]))
    await enter()
    await expect.poll(() => pageEl(0)!.querySelector('.textLayer span')).not.toBeNull()
    await page.getByTestId('pdf-tool-Highlight').click()
    selectFirstLine(0)
    await expect.poll(() => document.querySelectorAll('[data-testid="pdf-comment"]').length).toBe(1)
    expect(pageEl(0)!.querySelector('[data-kind="Highlight"] path')).not.toBeNull()
    await page.getByTestId('pdf-edit-undo').click()
    await expect.poll(() => document.querySelectorAll('[data-testid="pdf-comment"]').length).toBe(0)
    await page.getByTestId('pdf-edit-redo').click()
    await expect.poll(() => document.querySelectorAll('[data-testid="pdf-comment"]').length).toBe(1)

    await page.getByTestId('pdf-comment-reply-start').click()
    await page.getByRole('textbox', { name: 'Reply' }).fill('Done')
    await page.getByTestId('pdf-comment-send').click()
    await expect.element(page.getByTestId('pdf-comment-reply')).toHaveTextContent('Done')
    await page.getByTestId('pdf-comment-reviewed').click()
    await expect.element(page.getByTestId('pdf-comment')).toHaveAttribute('data-reviewed', 'true')

    const read = await saveAndRead()
    const hl = read.annotations.find((a) => a.kind === 'Highlight')!
    expect(hl).toMatchObject({ author: 'Alice Example', review: { state: 'Completed' } })
    const quads = (hl.shape as { quads: number[][] }).quads
    expect(quads).toHaveLength(1)
    // Over the text line (72pt from the left, the first baseline at 720pt).
    expect(quads[0]![0]).toBeGreaterThan(65)
    expect(quads[0]![1]).toBeGreaterThan(720)
    expect(read.annotations.find((a) => a.inReplyTo === hl.id)).toMatchObject({ contents: 'Done' })
  })

  it('draws a rectangle, and moves, recolours and deletes the file’s own note', async () => {
    await open(await makePdf([{ lines: ['x'] }], { notes: [{ page: 0, text: 'Existing note' }] }))
    await enter()
    await page.getByTestId('pdf-tool-Square').click()
    const surface = page.getByTestId('pdf-edit-surface')
    await userEvent.dragAndDrop(surface, surface, {
      sourcePosition: { x: 100, y: 300 },
      targetPosition: { x: 250, y: 400 },
    })
    await expect.poll(() => pageEl(0)!.querySelectorAll('[data-kind="Square"]').length).toBe(1)

    await page.getByTestId('pdf-tool-select').click()
    const note = document.querySelector<HTMLElement>('[data-testid="pdf-comment"]')!
    const existing = note.dataset.annotation!
    const hit = page.getByTestId('pdf-edit-hit').and(page.getByRole('button', { name: /^Note/ }))
    await userEvent.dragAndDrop(hit, surfaceOrPage(), { targetPosition: { x: 300, y: 300 } })
    await page.getByRole('radio', { name: 'Colour #3b82f6' }).click()

    const first = await (async () => {
      await page.getByTestId('pdf-edit-save').click()
      await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
      return readPdfContents({ bytes: api.writeBytes.mock.calls[0]![1] })
    })()
    expect(first.annotations.map((a) => a.kind).sort()).toEqual(['Square', 'Text'])
    const moved = first.annotations.find((a) => a.id === existing)!
    expect(moved).toMatchObject({
      contents: 'Existing note',
      color: [59 / 255, 130 / 255, 246 / 255],
    })
    expect(moved.rect[0]).not.toBe(400)
  })

  it('without the member’s name, Annotate stays off and says so; the form still works', async () => {
    await open(await makeFormPdf(), { author: undefined })
    await page.getByTestId('pdf-annotate').click()
    await expect.element(page.getByTestId('pdf-editor')).toHaveAttribute('data-mode', 'form')
    await expect.element(page.getByTestId('pdf-edit-no-author')).toBeVisible()
    await expect.element(page.getByTestId('pdf-edit-mode-annotate')).toBeDisabled()
  })

  it('fills the form with real inputs over the page and saves the values', async () => {
    await open(await makeFormPdf())
    await page.getByTestId('pdf-annotate').click()
    await expect.element(page.getByTestId('pdf-editor')).toHaveAttribute('data-ready', 'true')
    await page.getByTestId('pdf-edit-mode-form').click()
    await expect.element(page.getByRole('textbox', { name: 'locked' })).toBeDisabled()
    await page.getByRole('textbox', { name: 'name', exact: true }).fill('Ada Lovelace')
    await expect
      .element(page.getByRole('textbox', { name: 'name', exact: true }))
      .toHaveAttribute('maxlength', '20')
    await page.getByRole('checkbox', { name: 'agree' }).click()
    await page.getByRole('radio', { name: 'size: M' }).click()
    await page.getByRole('combobox', { name: 'country' }).selectOptions('Germany')
    await expect.element(page.getByText('Signature (not signed)')).toBeVisible()
    const read = await saveAndRead()
    const v = Object.fromEntries(read.form.fields.map((f) => [f.name, f.value]))
    expect(v).toMatchObject({ name: 'Ada Lovelace', agree: true, size: 'M', country: ['Germany'] })
  })

  it('says an XFA-only form can’t be filled', async () => {
    await open(await makeFormPdf({ xfaOnly: true }))
    await page.getByTestId('pdf-annotate').click()
    await page.getByTestId('pdf-edit-mode-form').click()
    await expect.element(page.getByTestId('pdf-form-xfa')).toHaveTextContent('can’t be filled here')
  })

  it('edits the document properties', async () => {
    await open(await makePdf([{ lines: ['x'] }], { title: 'Old title' }))
    await enter()
    await page.getByTestId('pdf-edit-properties').click()
    await expect.element(page.getByTestId('pdf-prop-title')).toHaveValue('Old title')
    await page.getByTestId('pdf-prop-title').fill('New title')
    await page.getByTestId('pdf-prop-keywords').fill('a, b')
    await page.getByTestId('pdf-prop-apply').click()
    const read = await saveAndRead()
    expect(read.properties).toMatchObject({ title: 'New title', keywords: 'a, b' })
  })

  it('shows who is editing, takes over, and keeps staged changes when the lock is lost', async () => {
    api.acquireLock.mockResolvedValueOnce({ state: 'locked', holder: bob })
    await open(await makePdf([{ lines: ['x'] }]))
    await page.getByTestId('pdf-annotate').click()
    await expect.element(page.getByTestId('pdf-edit-lock-holder')).toHaveTextContent('Bob')
    await expect.element(page.getByTestId('pdf-tool-Text')).toBeDisabled()
    await page.getByTestId('pdf-edit-takeover').click()
    await expect.element(page.getByTestId('pdf-editor')).toHaveAttribute('data-lock', 'held')
    expect(api.acquireLock).toHaveBeenLastCalledWith('f1', expect.any(String), true)
    await expect.poll(() => pageEl(0)?.dataset.drawn).toBe('true')

    await page.getByTestId('pdf-tool-Text').click()
    await page.getByTestId('pdf-edit-surface').click({ position: { x: 200, y: 200 } })
    await page.getByRole('textbox', { name: 'Note text' }).fill('Mine')
    await page.getByTestId('pdf-edit-draft-add').click()
    api.writeBytes.mockRejectedValueOnce(
      new api.DriveApiError('Bob took over editing.', 423, 'locked', bob),
    )
    await page.getByTestId('pdf-edit-save').click()
    await expect.element(page.getByTestId('pdf-edit-lost-banner')).toHaveTextContent('Bob')
    await expect.element(page.getByTestId('pdf-comment')).toHaveTextContent('Mine')
  })
})

function surfaceOrPage() {
  return page.getByTestId('pdf-edit-page').first()
}
