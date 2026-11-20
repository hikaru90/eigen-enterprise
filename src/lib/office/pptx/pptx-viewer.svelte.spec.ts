import { strToU8 } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import PptxViewer from './pptx-viewer.svelte'
import { buildPptx, para, ph, sp, xfrm } from './test-utils/build-pptx'

const { readBytes } = vi.hoisted(() => ({ readBytes: vi.fn<(id: string) => Promise<Uint8Array>>() }))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, readBytes } }
})

const title = (text: string) => sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para(text) })
const DECK = buildPptx({
  slides: [
    {
      shapes: title('First slide') + sp({ id: 3, name: 'Box', xfrm: xfrm(952500, 2857500, 2857500, 952500), geom: 'ellipse', spPr: '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>', body: para('Inside the ellipse') }),
      notes: ['Say hello first'],
    },
    { shapes: title('Second slide') },
    { shapes: title('Backup'), hidden: true },
    { shapes: title('Last slide') },
  ],
})

const props = { fileId: 'deck-1', name: 'Quarterly.pptx', canEdit: false, heartbeatMs: 10_000 }
const slideBox = () => page.getByTestId('pptx-slide')

describe('pptx-viewer.svelte', () => {
  beforeEach(() => {
    readBytes.mockReset()
    readBytes.mockResolvedValue(DECK)
  })

  it('loads the file and renders the current slide as SVG with real text', async () => {
    render(PptxViewer, props)
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 1 of 4')
    expect(readBytes).toHaveBeenCalledWith('deck-1')
    await expect.element(slideBox()).toHaveTextContent('First slide')
    const svg = slideBox().element().querySelector('svg.pptx-slide')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 1280 720')
    // The browser laid the text out inside the slide: the title sits in the master's title area.
    const titleText = [...svg.querySelectorAll('p')].find((p) => p.textContent === 'First slide')!
    const box = svg.getBoundingClientRect()
    const r = titleText.getBoundingClientRect()
    expect(r.width).toBeGreaterThan(0)
    expect(r.left).toBeGreaterThanOrEqual(box.left)
    expect(r.top).toBeGreaterThanOrEqual(box.top)
    expect(r.bottom).toBeLessThan(box.top + box.height / 3)
    expect(svg.querySelector('[data-shape="Box"] path')?.getAttribute('fill')).toBe('#4472c4')
  })

  it('thumbnails switch slides and mark the current one', async () => {
    render(PptxViewer, props)
    const thumbs = page.getByTestId('pptx-thumb')
    await expect.element(thumbs.nth(0)).toHaveAttribute('aria-current', 'true')
    await expect.element(thumbs.nth(2)).toHaveAccessibleName('Slide 3 (hidden)')
    await thumbs.nth(1).click()
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 2 of 4')
    await expect.element(slideBox()).toHaveTextContent('Second slide')
    await expect.element(thumbs.nth(1)).toHaveAttribute('aria-current', 'true')
    // thumbnails draw the slide too
    await expect.poll(() => thumbs.nth(3).element().querySelector('svg.pptx-slide')?.textContent).toContain('Last slide')
  })

  it('arrow keys, Page Down, Home and End move through the deck', async () => {
    render(PptxViewer, props)
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 1 of 4')
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 2 of 4')
    await userEvent.keyboard('{PageDown}')
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 3 of 4')
    await expect.element(page.getByTestId('pptx-hidden-badge')).toBeInTheDocument()
    await userEvent.keyboard('{End}')
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 4 of 4')
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 4 of 4')
    await userEvent.keyboard('{Home}')
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 1 of 4')
    await expect.element(page.getByTestId('pptx-prev')).toBeDisabled()
    await page.getByTestId('pptx-next').click()
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 2 of 4')
  })

  it('shows the speaker notes of the current slide, and can hide them', async () => {
    render(PptxViewer, props)
    const notes = page.getByTestId('pptx-notes')
    await expect.element(notes).toHaveTextContent('Say hello first')
    await page.getByTestId('pptx-thumb').nth(1).click()
    await expect.element(notes).toHaveTextContent('No speaker notes on this slide.')
    await page.getByTestId('pptx-notes-toggle').click()
    await expect.element(notes).not.toBeInTheDocument()
    await expect.element(page.getByTestId('pptx-notes-toggle')).toHaveAttribute('aria-pressed', 'false')
  })

  it('presenter mode: full window or screen, keys advance (skipping hidden slides), Esc leaves', async () => {
    const pageKeys = vi.fn()
    window.addEventListener('keydown', pageKeys)
    render(PptxViewer, props)
    await page.getByTestId('pptx-present').click()
    const presenter = page.getByTestId('pptx-presenter')
    await expect.element(presenter).toBeInTheDocument()
    await expect.element(page.getByTestId('pptx-presenter-slide')).toHaveTextContent('First slide')
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByTestId('pptx-presenter-slide')).toHaveTextContent('Second slide')
    await userEvent.keyboard(' ')
    await expect.element(page.getByTestId('pptx-presenter-slide')).toHaveTextContent('Last slide')
    await userEvent.keyboard('{Escape}')
    await expect.element(presenter).not.toBeInTheDocument()
    // the file page's own Escape (close the file) must not fire while presenting
    const escapes = pageKeys.mock.calls.map(([e]) => e as KeyboardEvent).filter((e) => e.key === 'Escape')
    expect(escapes.length === 0 || escapes.every((e) => e.defaultPrevented)).toBe(true)
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 4 of 4')
    window.removeEventListener('keydown', pageKeys)
  })

  it('a broken file shows a clear error instead of a viewer', async () => {
    readBytes.mockResolvedValue(strToU8('this is not a deck'))
    render(PptxViewer, props)
    const err = page.getByTestId('pptx-error')
    await expect.element(err).toHaveTextContent('This presentation could not be opened.')
    await expect.element(err).toHaveTextContent(/Not a ZIP package/)
  })

  it('a failed download shows its reason', async () => {
    readBytes.mockRejectedValue(new Error('Loading the file failed (404).'))
    render(PptxViewer, props)
    await expect.element(page.getByTestId('pptx-error')).toHaveTextContent('Loading the file failed (404).')
  })
})
