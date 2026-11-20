import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { DriveApiError, type DriveItem, type LockHolder, type LockView } from '$lib/drive/api'
import { openDeck, type Deck, type SpNode } from './model'
import PptxViewer from './pptx-viewer.svelte'
import { buildPptx, para, ph, PNG_1PX, sp, xfrm } from './test-utils/build-pptx'
import { extractText } from './text'

const api = vi.hoisted(() => ({
  readBytes: vi.fn<(id: string) => Promise<Uint8Array>>(),
  acquireLock: vi.fn<(id: string, session: string, takeover?: boolean) => Promise<LockView>>(),
  heartbeatLock: vi.fn<(id: string, session: string) => Promise<LockView>>(),
  releaseLock: vi.fn<(id: string, session: string) => Promise<void>>(),
  writeBytes: vi.fn<(id: string, bytes: Uint8Array, session: string) => Promise<{ file: DriveItem }>>(),
}))
vi.mock('$lib/drive/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('$lib/drive/api')>()
  return { ...real, driveApi: { ...real.driveApi, ...api } }
})

const bob: LockHolder = { userId: 'bob', sessionId: 'tab-bob', since: '2026-11-20T10:00:00Z', name: 'Bob' }
const title = (text: string) => sp({ id: 2, name: 'Title 1', ph: ph('title'), body: para(text) })
// 1280 × 720 px slide; the box sits at (100, 300) px, 300 × 100 px.
const BOX = sp({ id: 3, name: 'Box', xfrm: xfrm(952500, 2857500, 2857500, 952500), geom: 'rect', spPr: '<a:solidFill><a:srgbClr val="4472C4"/></a:solidFill>', body: para('Inside') })
const DECK = buildPptx({
  slides: [{ shapes: title('First slide') + BOX, notes: ['Say hello first'] }, { shapes: title('Second slide') }, { shapes: title('Third slide') }],
})

const props = { fileId: 'deck-1', name: 'Quarterly.pptx', canEdit: true, heartbeatMs: 600_000, saveDelayMs: 20, idleMs: 600_000 }

/** The deck as last saved. */
const saved = (): Deck => {
  const calls = api.writeBytes.mock.calls
  if (!calls.length) throw new Error('nothing saved')
  return openDeck(calls.at(-1)![1]).deck
}
const savedBytes = () => api.writeBytes.mock.calls.at(-1)![1]
const box = (d: Deck) => d.slides[0]!.shapes.find((s) => s.name === 'Box') as SpNode
const runsOf = (s: SpNode) => s.text!.paragraphs.flatMap((p) => p.runs)
const textOf = (s: SpNode) => s.text!.paragraphs.map((p) => p.runs.map((r) => (r.kind === 'break' ? '\n' : r.text)).join('')).join('\n')

function hit(name: string): Element {
  const el = document.querySelector(`[data-testid="pptx-hit"][aria-label="${name}"]`)
  if (!el) throw new Error(`no hit area ${name}`)
  return el
}
function centre(el: Element): [number, number] {
  const r = el.getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
}
/** A pointer drag in screen pixels (the overlay listens on the window while dragging). */
function drag(el: Element, by: [number, number], opts: { shiftKey?: boolean } = {}) {
  const [x, y] = centre(el)
  const ev = (type: string, cx: number, cy: number) => new PointerEvent(type, { bubbles: true, clientX: cx, clientY: cy, button: 0, pointerId: 1, ...opts })
  el.dispatchEvent(ev('pointerdown', x, y))
  window.dispatchEvent(ev('pointermove', x + by[0] / 2, y + by[1] / 2))
  window.dispatchEvent(ev('pointermove', x + by[0], y + by[1]))
  window.dispatchEvent(ev('pointerup', x + by[0], y + by[1]))
}
/** An HTML drag and drop of thumbnail `from` onto the top half of thumbnail `onto`. */
function dragThumb(from: number, onto: number) {
  const src = document.querySelectorAll('[data-testid="pptx-thumb"]')[from]!
  const li = document.querySelectorAll('[data-thumb]')[onto]!
  const box = li.getBoundingClientRect()
  const dataTransfer = new DataTransfer()
  const at = { bubbles: true, cancelable: true, dataTransfer, clientX: box.left + box.width / 2, clientY: box.top + 2 }
  src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
  li.dispatchEvent(new DragEvent('dragover', at))
  li.dispatchEvent(new DragEvent('drop', at))
  src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
}
/** Screen px per slide px. */
const scale = () => document.querySelector('[data-testid="pptx-slide"]')!.getBoundingClientRect().width / 1280

async function openEditor() {
  render(PptxViewer, props)
  await page.getByTestId('pptx-edit').click()
  await expect.element(page.getByTestId('pptx-toolbar')).toBeInTheDocument()
}

describe('pptx editor', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    // The server has what was last saved.
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? DECK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({ file: { id: 'deck-1', type: 'file', name: 'Quarterly.pptx' } as DriveItem }))
  })

  it('offers Edit only with edit access', async () => {
    render(PptxViewer, { ...props, canEdit: false })
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 1 of 3')
    expect(page.getByTestId('pptx-edit').query()).toBeNull()
  })

  it('selects a shape and drags it: the lock is taken with the first change, the move is saved', async () => {
    await openEditor()
    expect(api.acquireLock).not.toHaveBeenCalled()
    await userEvent.click(hit('Box'))
    await expect.element(page.getByTestId('pptx-selection')).toHaveAttribute('data-id', '3')
    await expect.element(page.getByTestId('pptx-handle')).toHaveLength(8)
    const k = scale()
    drag(hit('Box'), [100 * k, 50 * k])
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(api.acquireLock).toHaveBeenCalledTimes(1)
    const x = box(saved()).spPr.xfrm!
    expect(x.x / 9525).toBeCloseTo(200, 0)
    expect(x.y / 9525).toBeCloseTo(350, 0)
    expect(x.cx).toBe(2857500)
    await expect.element(page.getByTestId('pptx-save-state')).toHaveAttribute('data-status', 'saved')
    // the drawn shape is where the file says
    const drawn = document.querySelector('[data-testid="pptx-slide"] [data-sid="3"]')!
    expect(drawn.getAttribute('transform')).toBe('translate(200 350)')
  })

  it('resizes with a handle (Shift keeps the aspect), rotates with the rotate handle, nudges with the arrow keys', async () => {
    await openEditor()
    await userEvent.click(hit('Box'))
    const k = scale()
    const se = document.querySelector('[data-handle="se"]')!
    drag(se, [150 * k, 0], { shiftKey: true })
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    let x = box(saved()).spPr.xfrm!
    expect(x.cx / 9525).toBeCloseTo(450, 0)
    expect(x.cy / 9525).toBeCloseTo(150, 0)
    expect(x.x / 9525).toBeCloseTo(100, 0)
    const rot = document.querySelector('[data-testid="pptx-rotate-handle"]')!
    const [cx, cy] = centre(hit('Box'))
    const [hx, hy] = centre(rot)
    // drag the handle to the right of the centre: a quarter turn
    rot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hx, clientY: hy, button: 0 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + 200, clientY: cy }))
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: cx + 200, clientY: cy }))
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(2)
    expect(box(saved()).spPr.xfrm!.rot).toBeCloseTo(90, 0)
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(3)
    x = box(saved()).spPr.xfrm!
    expect(x.x / 9525).toBeCloseTo(90, 0)
    // the slide did not change: arrows move the selection, not the slide
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 1 of 3')
  })

  it('double-click types into the text in place; Escape commits; formatting from the toolbar; undo and redo', async () => {
    await openEditor()
    await userEvent.dblClick(hit('Box'))
    const editor = page.getByTestId('pptx-text-editor')
    await expect.element(editor).toHaveAttribute('contenteditable', 'true')
    await userEvent.keyboard(' and more')
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(textOf(box(saved()))).toBe('Inside and more')
    expect(await extractText(savedBytes())).toContain('- Inside and more')
    // the shape stays selected: Bold applies to all of its text
    await expect.element(page.getByTestId('pptx-selection')).toHaveAttribute('data-id', '3')
    await page.getByTestId('pptx-bold').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(2)
    expect(runsOf(box(saved())).every((r) => r.props.bold === true)).toBe(true)
    await expect.element(page.getByTestId('pptx-bold')).toHaveAttribute('aria-pressed', 'true')
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{Meta>}z{/Meta}')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(3)
    expect(runsOf(box(saved())).some((r) => r.props.bold)).toBe(false)
    await page.getByTestId('pptx-redo').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(4)
    expect(runsOf(box(saved())).every((r) => r.props.bold === true)).toBe(true)
  })

  it('formats only the selected words while typing', async () => {
    await openEditor()
    await userEvent.dblClick(hit('Box'))
    await expect.element(page.getByTestId('pptx-text-editor')).toBeInTheDocument()
    // select "side" (characters 2–6 of "Inside")
    const root = page.getByTestId('pptx-text-editor').element()
    const text = root.querySelector('[data-r="0"]')!.firstChild!
    const r = document.createRange()
    r.setStart(text, 2)
    r.setEnd(text, 6)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(r)
    await page.getByTestId('pptx-italic').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    const runs = runsOf(box(saved()))
    expect(runs.map((x) => (x.kind === 'run' ? [x.text, x.props.italic ?? false] : null))).toEqual([
      ['In', false],
      ['side', true],
    ])
    // still typing, the same words selected
    await expect.element(page.getByTestId('pptx-text-editor')).toHaveAttribute('contenteditable', 'true')
    expect(document.getSelection()!.toString()).toBe('side')
  })

  it('inserts a text box (typing straight away) and a picture from the computer; deletes with the keyboard', async () => {
    await openEditor()
    await page.getByTestId('pptx-insert-text').click()
    await expect.element(page.getByTestId('pptx-text-editor')).toBeInTheDocument()
    await userEvent.keyboard('Hello box')
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBeGreaterThan(0)
    await expect.poll(() => saved().slides[0]!.shapes.map((s) => (s.kind === 'sp' && s.text ? textOf(s) : s.name))).toEqual(['First slide', 'Inside', 'Hello box'])
    const input = page.getByTestId('pptx-picture-input')
    await userEvent.upload(input, new File([PNG_1PX], 'logo.png', { type: 'image/png' }))
    await expect.poll(() => saved().slides[0]!.shapes.at(-1)?.kind).toBe('pic')
    expect(saved().slides[0]!.shapes.at(-1)!.name).toBe('logo')
    // the new picture is selected: Delete removes it
    await expect.element(page.getByTestId('pptx-selection')).toBeInTheDocument()
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{Delete}')
    await expect.poll(() => saved().slides[0]!.shapes.some((s) => s.kind === 'pic')).toBe(false)
  })

  it('slides from the rail: duplicate, hide, add from a layout, delete, drag to reorder', async () => {
    await openEditor()
    const thumbs = page.getByTestId('pptx-thumb')
    await page.getByTestId('pptx-thumb-menu').nth(0).click()
    await page.getByTestId('pptx-slide-duplicate').click()
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 2 of 4')
    await page.getByTestId('pptx-thumb-menu').nth(1).click()
    await page.getByTestId('pptx-slide-hide').click()
    await expect.element(thumbs.nth(1)).toHaveAccessibleName('Slide 2 (hidden)')
    await page.getByTestId('pptx-new-slide').click()
    await page.getByTestId('pptx-layout').getByText('Title Slide').click()
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 3 of 5')
    await expect.poll(() => saved().slides.map((s) => s.layout.split('/').pop())).toEqual(['slideLayout1.xml', 'slideLayout1.xml', 'slideLayout2.xml', 'slideLayout1.xml', 'slideLayout1.xml'])
    expect(saved().slides[1]!.hidden).toBe(true)
    expect(saved().slides[2]!.shapes.map((s) => s.ph?.type)).toEqual(['ctrTitle', 'subTitle'])
    await page.getByTestId('pptx-thumb-menu').nth(2).click()
    await page.getByTestId('pptx-slide-delete').click()
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('of 4')
    // drag the last slide to the top (above the first thumbnail's middle)
    dragThumb(3, 0)
    await expect.poll(() => saved().slides.map((s) => s.shapes.find((x) => x.ph?.type === 'title') as SpNode).map((t) => textOf(t))).toEqual(['Third slide', 'First slide', 'First slide', 'Second slide'])
  })

  it('edits the speaker notes', async () => {
    await openEditor()
    const notes = page.getByTestId('pptx-notes-editor')
    await expect.element(notes).toHaveValue('Say hello first')
    await notes.click()
    await userEvent.keyboard('{End} — and smile')
    await page.getByTestId('pptx-thumb').nth(1).click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(await extractText(savedBytes())).toContain('> Notes: Say hello first — and smile')
    await expect.element(notes).toHaveValue('')
  })

  it('someone else is editing: says who, changes nothing, Take over reloads and edits', async () => {
    api.acquireLock.mockResolvedValueOnce({ state: 'locked', holder: bob })
    await openEditor()
    await userEvent.click(hit('Box'))
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByTestId('pptx-lock-banner')).toHaveTextContent('Bob is editing.')
    expect(page.getByTestId('pptx-toolbar').query()).toBeNull()
    await page.getByTestId('pptx-takeover').click()
    await expect.element(page.getByTestId('pptx-toolbar')).toBeInTheDocument()
    expect(api.acquireLock).toHaveBeenLastCalledWith('deck-1', expect.any(String), true)
    expect(api.readBytes).toHaveBeenCalledTimes(2)
    expect(api.writeBytes).not.toHaveBeenCalled()
  })

  it('a newer saved version is never overwritten: it is reloaded first', async () => {
    const newer = buildPptx({ slides: [{ shapes: title('Changed by Bob') + BOX }] })
    api.readBytes.mockResolvedValueOnce(DECK).mockResolvedValue(newer)
    await openEditor()
    await userEvent.click(hit('Box'))
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByTestId('pptx-notice')).toHaveTextContent('Someone saved a newer version')
    await expect.element(page.getByTestId('pptx-slide')).toHaveTextContent('Changed by Bob')
    expect(api.writeBytes).not.toHaveBeenCalled()
  })

  it('losing the lock keeps the work on screen, says who took over, offers the copy', async () => {
    await openEditor()
    api.writeBytes.mockRejectedValueOnce(new DriveApiError('Bob is editing this file.', 409, 'locked', bob))
    await userEvent.click(hit('Box'))
    const k = scale()
    drag(hit('Box'), [100 * k, 0])
    await expect.element(page.getByTestId('pptx-lost-banner')).toHaveTextContent('Bob took over editing.')
    // the moved box is still where it was moved to
    expect(document.querySelector('[data-testid="pptx-slide"] [data-sid="3"]')!.getAttribute('transform')).toBe('translate(200 300)')
    expect(page.getByTestId('pptx-toolbar').query()).toBeNull()
    await expect.element(page.getByTestId('pptx-download-copy')).toBeInTheDocument()
  })

  it('lets the lock go after a quiet spell, and on Done', async () => {
    render(PptxViewer, { ...props, idleMs: 150 })
    await page.getByTestId('pptx-edit').click()
    await userEvent.click(hit('Box'))
    ;(page.getByTestId('pptx-viewer').element() as HTMLElement).focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    await expect.poll(() => api.releaseLock.mock.calls.length).toBe(1)
    await expect.element(page.getByTestId('pptx-save-state')).toHaveAttribute('data-held', 'false')
    // the next change takes it again
    await userEvent.keyboard('{ArrowDown}')
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(2)
    expect(api.acquireLock).toHaveBeenCalledTimes(2)
    await page.getByTestId('pptx-done').click()
    await expect.element(page.getByTestId('pptx-edit')).toBeInTheDocument()
    expect(api.releaseLock).toHaveBeenCalledTimes(2)
  })
})
