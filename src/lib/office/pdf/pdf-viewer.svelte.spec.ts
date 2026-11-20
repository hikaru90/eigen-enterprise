import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { OFFICE_VIEWERS } from '../viewers'
import { brokenPdf, encryptedPdf, makePdf, type FixturePage } from './fixtures'
import PdfViewer from './pdf-viewer.svelte'

const { readBytes } = vi.hoisted(() => ({
  readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
}))
vi.mock('$lib/drive/api', () => ({ driveApi: { readBytes } }))

const LETTER: [number, number] = [612, 792]
const LANDSCAPE: [number, number] = [792, 612]

function pages(n: number, extra: Record<number, string[]> = {}): FixturePage[] {
  return Array.from({ length: n }, (_, i) => ({
    lines: [`Page ${i + 1} heading`, 'Plain body text for this page.', ...(extra[i] ?? [])],
    size: i === 2 ? LANDSCAPE : LETTER,
  }))
}

let host: HTMLDivElement
beforeEach(() => {
  vi.clearAllMocks()
  host = document.createElement('div')
  host.style.width = '1000px'
  host.style.height = '700px'
  host.style.display = 'flex'
  host.style.flexDirection = 'column'
  document.body.append(host)
})
afterEach(() => host.remove())

async function open(bytes: Uint8Array) {
  readBytes.mockResolvedValue(bytes)
  const screen = render(PdfViewer, {
    target: host,
    props: { fileId: 'f1', name: 'report.pdf', canEdit: false, heartbeatMs: 10_000 },
  })
  return screen
}

const viewer = () => page.getByTestId('pdf-viewer')
const pageEl = (i: number) =>
  document.querySelector<HTMLElement>(`[data-testid="pdf-page"][data-page="${i}"]`)!
const scroller = () => document.querySelector<HTMLElement>('[data-testid="pdf-pages"]')!

async function ready() {
  await expect.element(viewer()).toHaveAttribute('data-status', 'ready')
}

describe('PDF viewer', () => {
  it('is the Drive’s viewer for PDFs', async () => {
    expect((await OFFICE_VIEWERS.pdf!()).default).toBe(PdfViewer)
  })

  it('lays out every page at its own size and draws only those near the viewport', async () => {
    await open(await makePdf(pages(6)))
    await ready()
    expect(readBytes).toHaveBeenCalledWith('f1')
    expect(document.querySelectorAll('[data-testid="pdf-page"]')).toHaveLength(6)
    const portrait = pageEl(0).getBoundingClientRect()
    const landscape = pageEl(2).getBoundingClientRect()
    expect(portrait.height / portrait.width).toBeCloseTo(792 / 612, 1)
    expect(landscape.height / landscape.width).toBeCloseTo(612 / 792, 1)
    await expect.poll(() => pageEl(0).dataset.drawn).toBe('true')
    expect(pageEl(0).querySelector('canvas')).not.toBeNull()
    expect(pageEl(5).querySelector('canvas')).toBeNull()
    await expect.element(page.getByTestId('pdf-page-input')).toHaveValue('1')
    await expect.element(page.getByTestId('pdf-page-count')).toHaveTextContent('of 6')
  })

  it('puts the text in a selectable layer, in reading order', async () => {
    await open(await makePdf([{ lines: ['First line here', 'Second line there'] }]))
    await ready()
    await expect.poll(() => pageEl(0).querySelector('.textLayer .endOfContent')).not.toBeNull()
    const text = pageEl(0).querySelector('.textLayer')!.textContent!
    expect(text.indexOf('First line here')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('First line here')).toBeLessThan(text.indexOf('Second line there'))
  })

  it('thumbnails show the pages lazily and jump to a page', async () => {
    await open(await makePdf(pages(6)))
    await ready()
    const toggle = page.getByTestId('pdf-toggle-thumbnails')
    if (toggle.element().getAttribute('aria-pressed') !== 'true') await toggle.click()
    await expect.element(page.getByTestId('pdf-thumbnails')).toBeVisible()
    const thumbs = page.getByTestId('pdf-thumb')
    await expect
      .poll(() => thumbs.nth(0).element().querySelector('[data-drawn="true"] canvas'))
      .not.toBeNull()
    await thumbs.nth(4).click()
    await expect.element(page.getByTestId('pdf-page-input')).toHaveValue('5')
    await expect.element(thumbs.nth(4)).toHaveAttribute('aria-current', 'page')
    expect(Math.abs(scroller().scrollTop - (pageEl(4).offsetTop - 6))).toBeLessThan(2)
    await expect.poll(() => pageEl(4).dataset.drawn).toBe('true')
  })

  it('finds as you type: counts matches, highlights them, steps through them', async () => {
    await open(
      await makePdf(pages(5, { 0: ['A needle here.'], 3: ['Needle one.', 'And needle two.'] })),
    )
    await ready()
    await page.getByTestId('pdf-find').fill('needle')
    await expect.element(page.getByTestId('pdf-find-status')).toHaveTextContent('1 of 3')
    await expect.poll(() => pageEl(0).querySelectorAll('.textLayer .highlight').length).toBe(1)
    expect(pageEl(0).querySelector('.textLayer .highlight.selected')!.textContent).toBe('needle')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByTestId('pdf-find-status')).toHaveTextContent('2 of 3')
    await expect.element(page.getByTestId('pdf-page-input')).toHaveValue('4')
    await expect.poll(() => pageEl(3).querySelectorAll('.textLayer .highlight').length).toBe(2)
    await expect
      .poll(() => pageEl(3).querySelector('.highlight.selected')?.textContent)
      .toBe('Needle')
    await page.getByTestId('pdf-find-prev').click()
    await expect.element(page.getByTestId('pdf-find-status')).toHaveTextContent('1 of 3')
    await page.getByTestId('pdf-find').fill('nothing like this')
    await expect.element(page.getByTestId('pdf-find-status')).toHaveTextContent('No matches')
    await expect.poll(() => pageEl(0).querySelectorAll('.textLayer .highlight').length).toBe(0)
  })

  it('zooms in steps and to fit, scaling the pages', async () => {
    await open(await makePdf(pages(3)))
    await ready()
    const fitted = pageEl(0).getBoundingClientRect().width
    const zoomAt = () => Number(viewer().element().getAttribute('data-zoom'))
    const before = zoomAt()
    await page.getByTestId('pdf-zoom-in').click()
    expect(zoomAt()).toBeGreaterThan(before)
    expect(pageEl(0).getBoundingClientRect().width).toBeGreaterThan(fitted)
    await page.getByTestId('pdf-fit-page').click()
    await expect.element(page.getByTestId('pdf-fit-page')).toHaveAttribute('aria-pressed', 'true')
    expect(pageEl(0).getBoundingClientRect().height).toBeLessThanOrEqual(scroller().clientHeight)
    await page.getByTestId('pdf-fit-width').click()
    expect(pageEl(0).getBoundingClientRect().width).toBeCloseTo(fitted, 0)
    await expect
      .element(page.getByTestId('pdf-zoom-label'))
      .toHaveTextContent(`${Math.round(zoomAt() * 100)}%`)
  })

  it('ctrl+wheel zooms around the pointer', async () => {
    await open(await makePdf(pages(3)))
    await ready()
    const before = Number(viewer().element().getAttribute('data-zoom'))
    const rect = scroller().getBoundingClientRect()
    scroller().dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -200,
        ctrlKey: true,
        clientX: rect.left + 50,
        clientY: rect.top + 50,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(Number(viewer().element().getAttribute('data-zoom'))).toBeGreaterThan(before)
  })

  it('shows page labels and goes to a page by label or number', async () => {
    await open(
      await makePdf(pages(4), {
        labels: [
          { from: 0, style: 'r' },
          { from: 2, style: 'D' },
        ],
      }),
    )
    await ready()
    const input = page.getByTestId('pdf-page-input')
    await expect.element(input).toHaveValue('i')
    await expect.element(page.getByTestId('pdf-page-count')).toHaveTextContent('(1 of 4)')
    await input.fill('2')
    await userEvent.keyboard('{Enter}')
    await expect.element(input).toHaveValue('2')
    await expect.element(page.getByTestId('pdf-page-count')).toHaveTextContent('(4 of 4)')
    await input.fill('ii')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByTestId('pdf-page-count')).toHaveTextContent('(2 of 4)')
    await input.fill('xl')
    await userEvent.keyboard('{Enter}')
    await expect
      .element(page.getByTestId('pdf-nav-error'))
      .toHaveTextContent('There is no page “xl”.')
  })

  it('lists the bookmarks and opens them', async () => {
    await open(
      await makePdf(pages(5), {
        outline: [
          { title: 'Introduction', page: 0 },
          { title: 'Results', page: 3, children: [{ title: 'Tables', page: 4 }] },
        ],
      }),
    )
    await ready()
    await page.getByTestId('pdf-toggle-outline').click()
    const outline = page.getByTestId('pdf-outline')
    await expect.element(outline).toHaveTextContent('Introduction')
    await outline.getByRole('button', { name: 'Tables' }).click()
    await expect.element(page.getByTestId('pdf-page-input')).toHaveValue('5')
    await outline.getByRole('button', { name: 'Results' }).click()
    await expect.element(page.getByTestId('pdf-page-input')).toHaveValue('4')
  })

  it('keyboard: End, Home, PageDown move by page; ⌘/Ctrl+F focuses find', async () => {
    await open(await makePdf(pages(5)))
    await ready()
    const input = page.getByTestId('pdf-page-input')
    await userEvent.keyboard('{End}')
    await expect.element(input).toHaveValue('5')
    await userEvent.keyboard('{Home}')
    await expect.element(input).toHaveValue('1')
    await userEvent.keyboard('{PageDown}')
    await expect.element(input).toHaveValue('2')
    await userEvent.keyboard('{Control>}f{/Control}')
    await expect.element(page.getByTestId('pdf-find')).toHaveFocus()
  })

  it('dark pages inverts the page colours on request', async () => {
    await open(await makePdf(pages(1)))
    await ready()
    const toggle = page.getByTestId('pdf-dark-pages')
    await expect.element(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()
    await expect.element(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(scroller().classList).toContain('dark-pages')
  })

  it('asks for the password of a protected PDF and says when it is wrong', async () => {
    await open(encryptedPdf('s3cret', 'Behind the lock'))
    const form = page.getByTestId('pdf-password')
    await expect.element(form).toBeVisible()
    await page.getByTestId('pdf-password-input').fill('wrong')
    await page.getByTestId('pdf-password-submit').click()
    await expect.element(page.getByTestId('pdf-password-wrong')).toBeVisible()
    await expect.element(page.getByTestId('pdf-password-input')).toHaveValue('')
    await page.getByTestId('pdf-password-input').fill('s3cret')
    await page.getByTestId('pdf-password-submit').click()
    await ready()
    await expect
      .poll(() => pageEl(0).querySelector('.textLayer')?.textContent ?? '')
      .toContain('Behind the lock')
  })

  it('a broken file shows a clear error', async () => {
    await open(brokenPdf())
    const error = page.getByTestId('pdf-error')
    await expect.element(error).toBeVisible()
    await expect.element(error).toHaveTextContent('This file is damaged or is not a PDF')
  })

  it('a file that cannot be loaded says so', async () => {
    readBytes.mockRejectedValue(new Error('Loading the file failed (404).'))
    render(PdfViewer, {
      target: host,
      props: { fileId: 'f1', name: 'gone.pdf', canEdit: false, heartbeatMs: 10_000 },
    })
    await expect
      .element(page.getByTestId('pdf-error'))
      .toHaveTextContent('The file could not be loaded.')
    await expect
      .element(page.getByTestId('pdf-error-detail'))
      .toHaveTextContent('Loading the file failed (404).')
  })
})
