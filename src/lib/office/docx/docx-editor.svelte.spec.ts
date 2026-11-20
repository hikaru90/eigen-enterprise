import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import DocxViewer from './docx-viewer.svelte'
import { buildDocx, p, r, sectPr } from './test-utils/builder'

/** A decodable 1×1 PNG (the insert flow measures the picture with createImageBitmap). */
const PNG_1PX = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130])

const api = vi.hoisted(() => ({
  readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
  acquireLock: vi.fn(),
  heartbeatLock: vi.fn(),
  releaseLock: vi.fn(),
  writeBytes: vi.fn(),
}))
vi.mock('$lib/drive/api', () => {
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
  return { driveApi: api, DriveApiError }
})

const STYLES =
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
const DANA = { userId: 'u2', sessionId: 's2', since: '2026-11-20T10:00:00Z', name: 'Dana' }

const docXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['word/document.xml']!)
const saved = () => api.writeBytes.mock.calls.map((c) => c[1] as Uint8Array)
const surface = () => document.querySelector<HTMLElement>('.docx-edit-surface')!
/** The Edit layout (the Print layout's pages stay in the DOM next to it). */
const edit = () => page.getByTestId('docx-edit-page')

async function openEditor(props: Record<string, unknown> = {}) {
  const onsaved = vi.fn()
  render(DocxViewer, { fileId: 'f1', name: 'report.docx', canEdit: true, heartbeatMs: 10_000, saveDelayMs: 30, onsaved, ...props })
  await expect.element(page.getByTestId('docx-page-indicator')).toHaveTextContent(/Page 1 of 1/)
  await userEvent.click(page.getByTestId('docx-edit'))
  await expect.element(page.getByTestId('docx-edit-toolbar')).toBeVisible()
  return { onsaved }
}

/** Puts the cursor at the end of the paragraph showing `text` and types. */
async function typeAfter(text: string, typed: string) {
  await userEvent.click(edit().getByText(text))
  // The caret goes right after the text (the browser reports the DOM selection to the editor).
  const node = [...surface().querySelectorAll('p')].flatMap((el) => [...el.childNodes]).map((n) => (n.nodeType === 3 ? n : n.lastChild)).find((n) => n?.textContent === text)
  if (!node) throw new Error(`no text node "${text}"`)
  document.getSelection()!.collapse(node, text.length)
  await new Promise((resolve) => setTimeout(resolve, 50))
  await userEvent.keyboard(typed)
}

describe('DocxViewer editing', () => {
  beforeEach(() => {
    for (const f of Object.values(api)) f.mockReset()
    api.readBytes.mockResolvedValue(buildDocx({ styles: STYLES, body: p(r('Hello Word')) + p(r('Second line')) + sectPr() }))
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockResolvedValue({ file: { id: 'f1', size: 1 } })
  })

  it('offers Edit only with edit access', async () => {
    render(DocxViewer, { fileId: 'f1', name: 'report.docx', canEdit: false, heartbeatMs: 10_000 })
    await expect.element(page.getByTestId('docx-page-indicator')).toHaveTextContent(/Page 1 of 1/)
    expect(document.querySelector('[data-testid="docx-edit"]')).toBeNull()
  })

  it('opens the Edit layout without taking the lock; the first change takes it and autosaves the .docx', async () => {
    const { onsaved } = await openEditor()
    await expect.element(edit().getByText('Hello Word')).toBeVisible()
    expect(api.acquireLock).not.toHaveBeenCalled()
    await typeAfter('Hello Word', '!')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    expect(api.acquireLock).toHaveBeenCalledWith('f1', expect.any(String), false)
    const last = saved().at(-1)!
    expect(docXml(last)).toContain('Hello Word!')
    // The other paragraph is written back as it was.
    expect(docXml(last)).toContain('<w:p><w:r><w:t xml:space="preserve">Second line</w:t></w:r></w:p>')
    await expect.element(page.getByTestId('docx-save-state')).toHaveAttribute('data-status', 'saved')
    expect(onsaved).toHaveBeenCalledWith({ id: 'f1', size: 1 })
  })

  it('formats with the toolbar and the keyboard, and undoes', async () => {
    await openEditor()
    await userEvent.tripleClick(edit().getByText('Second line'))
    await userEvent.click(page.getByRole('button', { name: 'Bold' }))
    await expect.element(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
    expect(surface().querySelector('strong')?.textContent).toBe('Second line')
    await userEvent.selectOptions(page.getByTestId('docx-style'), 'Heading1')
    await expect.element(edit().getByRole('heading', { level: 1 })).toHaveTextContent('Second line')
    await expect.poll(() => saved().length).toBeGreaterThan(0)
    await expect.poll(() => docXml(saved().at(-1)!)).toContain('<w:pStyle w:val="Heading1"/>')
    expect(docXml(saved().at(-1)!)).toContain('<w:rPr><w:b/><w:bCs/></w:rPr>')
    await userEvent.click(page.getByRole('button', { name: 'Undo' }))
    await expect.element(edit().getByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })

  it('makes bulleted lists with a visible marker', async () => {
    await openEditor()
    await userEvent.click(edit().getByText('Second line'))
    await userEvent.click(page.getByRole('button', { name: 'Bulleted list' }))
    await expect.element(page.getByTestId('docx-list-label')).toHaveTextContent('•')
    await expect.poll(() => saved().length).toBeGreaterThan(0)
    await expect.poll(() => strFromU8(unzipSync(saved().at(-1)!)['word/numbering.xml'] ?? new Uint8Array())).toContain('w:numFmt w:val="bullet"')
  })

  it('Done lays the pages out again from the edited document', async () => {
    await openEditor()
    await typeAfter('Second line', ' changed')
    await expect.poll(() => saved().length).toBeGreaterThan(0)
    await userEvent.click(page.getByTestId('docx-done'))
    await expect.element(page.getByTestId('docx-page-indicator')).toHaveTextContent(/Page 1 of 1/)
    expect(document.querySelector('[data-testid="docx-page"] .docx-body')?.textContent).toContain('Second line changed')
    expect(api.releaseLock).toHaveBeenCalled()
  })

  it('says who is editing when the lock is taken; the copy turns read-only and Take over loads their version', async () => {
    api.acquireLock.mockResolvedValueOnce({ state: 'locked', holder: DANA })
    await openEditor()
    await typeAfter('Hello Word', '?')
    await expect.element(page.getByTestId('docx-lock-banner')).toHaveTextContent('Dana is editing this document')
    expect(surface().getAttribute('contenteditable')).toBe('false')
    await expect.element(page.getByTestId('docx-download-draft')).toBeVisible()
    // What was typed stays on screen.
    expect(surface().textContent).toContain('Hello Word?')
    api.readBytes.mockResolvedValue(buildDocx({ styles: STYLES, body: p(r('Dana’s version')) + sectPr() }))
    await userEvent.click(page.getByTestId('docx-takeover'))
    await expect.element(edit().getByText('Dana’s version')).toBeVisible()
    expect(api.acquireLock).toHaveBeenLastCalledWith('f1', expect.any(String), true)
    expect(surface().getAttribute('contenteditable')).toBe('true')
  })

  it('when someone takes over mid-edit, the unsaved changes stay visible with who took over', async () => {
    api.heartbeatLock.mockResolvedValue({ state: 'locked', holder: DANA })
    api.writeBytes.mockImplementation(() => new Promise(() => {}))
    await openEditor({ heartbeatMs: 80, saveDelayMs: 10_000 })
    await typeAfter('Hello Word', ' draft')
    await expect.element(page.getByTestId('docx-lock-banner')).toHaveTextContent('Dana took over editing')
    expect(surface().textContent).toContain('Hello Word draft')
    expect(surface().getAttribute('contenteditable')).toBe('false')
    await expect.element(page.getByTestId('docx-download-draft')).toBeVisible()
  })

  it('lets the lock go after a quiet spell, everything saved first', async () => {
    await openEditor({ idleMs: 150 })
    await typeAfter('Hello Word', '.')
    await expect.poll(() => api.releaseLock.mock.calls.length, { timeout: 3000 }).toBeGreaterThan(0)
    expect(docXml(saved().at(-1)!)).toContain('Hello Word.')
    await expect.element(page.getByTestId('docx-edit-mode')).toHaveAttribute('data-mode', 'idle')
  })

  it('adds a link from the link bar', async () => {
    await openEditor()
    await userEvent.dblClick(edit().getByText('Second line'))
    await userEvent.click(page.getByRole('button', { name: 'Link' }))
    await userEvent.fill(page.getByTestId('docx-link-input'), 'notaurl')
    await userEvent.click(page.getByTestId('docx-link-apply'))
    await expect.element(page.getByRole('alert')).toHaveTextContent('Use a web address')
    await userEvent.fill(page.getByTestId('docx-link-input'), 'https://example.com/')
    await userEvent.click(page.getByTestId('docx-link-apply'))
    await expect.poll(() => surface().querySelector('a.docx-link')?.getAttribute('href')).toBe('https://example.com/')
    await expect.poll(() => (saved().length ? docXml(saved().at(-1)!) : '')).toMatch(/<w:hyperlink r:id="rId\d+">/)
  })

  it('inserts a picture from the toolbar into the document and the saved .docx', async () => {
    await openEditor()
    await userEvent.click(edit().getByText('Hello Word'))
    // The hidden file input gets its file the way a file picker hands it over.
    const input = document.querySelector<HTMLInputElement>('[data-testid="docx-image-input"]')!
    const dt = new DataTransfer()
    dt.items.add(new File([PNG_1PX], 'logo.png', { type: 'image/png' }))
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await expect.element(edit().getByAltText('logo.png')).toBeVisible()
    await expect.poll(() => saved().length).toBeGreaterThan(0)
    const out = saved().at(-1)!
    expect(unzipSync(out)['word/media/added-1.png']).toEqual(PNG_1PX)
    expect(docXml(out)).toMatch(/<w:drawing><wp:inline[^>]*>.+r:embed="rId\d+"/)
  })
})
