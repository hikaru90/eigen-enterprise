import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { DriveItem, LockView } from '$lib/drive/api'
import { openDeck, type Deck } from './model'
import PptxViewer from './pptx-viewer.svelte'
import { BOB, commentedPptx } from './test-utils/comment-fixtures'

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

const DECK = commentedPptx()
const props = { fileId: 'deck-1', name: 'Review.pptx', canEdit: true, heartbeatMs: 600_000, saveDelayMs: 20, idleMs: 600_000, author: BOB }

const savedBytes = () => api.writeBytes.mock.calls.at(-1)![1]
const saved = (): Deck => openDeck(savedBytes()).deck

/** ZIP entries that differ between the original deck and the last save. */
function changedSinceOpen(): string[] {
  const a = unzipSync(DECK)
  const b = unzipSync(savedBytes())
  const same = (x: Uint8Array | undefined, y: Uint8Array | undefined) => !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i])
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => !same(a[n], b[n])).sort()
}

async function openComments(p: Record<string, unknown> = props) {
  render(PptxViewer, p)
  await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 1 of 3')
  await page.getByTestId('pptx-comments-toggle').click()
  await expect.element(page.getByTestId('pptx-comments')).toBeInTheDocument()
}

describe('pptx comments in the viewer', () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.readBytes.mockImplementation(async () => api.writeBytes.mock.calls.at(-1)?.[1] ?? DECK)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-21T10:00:00Z' })
    api.heartbeatLock.mockResolvedValue({ state: 'held', since: '2026-11-21T10:00:00Z' })
    api.releaseLock.mockResolvedValue(undefined)
    api.writeBytes.mockImplementation(async () => ({ file: { id: 'deck-1', type: 'file', name: 'Review.pptx' } as DriveItem }))
  })

  it('marks open threads on the slide and counts them on the thumbnails; a marker opens its thread', async () => {
    render(PptxViewer, props)
    await expect.element(page.getByTestId('pptx-comment-marker')).toHaveLength(2)
    await expect.element(page.getByTestId('pptx-thumb').nth(0)).toHaveAccessibleName('Slide 1, 2 open comments')
    await expect.element(page.getByTestId('pptx-thumb').nth(1)).toHaveAccessibleName('Slide 2, 1 open comment')
    await expect.element(page.getByTestId('pptx-thumb').nth(2)).toHaveAccessibleName('Slide 3')
    expect([...document.querySelectorAll('[data-testid="pptx-thumb-comments"]')].map((e) => e.textContent?.trim())).toEqual(['2', '1'])
    const marker = page.getByTestId('pptx-comment-marker').nth(1)
    await expect.element(marker).toHaveAccessibleName('Comment 3')
    await marker.click()
    await expect.element(page.getByTestId('pptx-comments')).toBeInTheDocument()
    await expect.element(page.getByTestId('pptx-thread').nth(2)).toHaveClass(/ring-primary/)
  })

  it('adds a comment on the slide: it takes the lock, saves, and only comment parts change; undo takes it back', async () => {
    await openComments()
    await page.getByTestId('pptx-comment-new').click()
    await page.getByTestId('pptx-comment-text').fill('Needs a source')
    await page.getByTestId('pptx-comment-post').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(1)
    expect(api.acquireLock).toHaveBeenCalledTimes(1)
    const t = saved().slides[0]!.comments.threads.at(-1)!
    expect(t).toMatchObject({ text: 'Needs a source', anchor: { kind: 'slide' }, pos: null, authorId: '{B2}', author: { name: 'Bob Brown' } })
    expect(changedSinceOpen()).toEqual(['ppt/comments/modernComment_100_1.xml'])
    await expect.element(page.getByTestId('pptx-thread')).toHaveLength(4)
    // Commenting started editing: Done is there, and undo works like any change
    await expect.element(page.getByTestId('pptx-done')).toBeInTheDocument()
    await page.getByTestId('pptx-undo').click()
    await expect.poll(() => api.writeBytes.mock.calls.length).toBe(2)
    expect(changedSinceOpen()).toEqual([])
  })

  it('replies and resolves through the panel, saved to the file', async () => {
    await openComments()
    const first = page.getByTestId('pptx-thread').nth(0)
    await first.getByTestId('pptx-thread-reply').click()
    await first.getByTestId('pptx-reply-text-input').fill('Source added')
    await first.getByTestId('pptx-reply-send').click()
    await expect.poll(() => saved().slides[0]!.comments.threads[0]!.replies.map((r) => r.text)).toEqual(['On it.', 'Thanks', 'Source added'])
    await first.getByTestId('pptx-thread-resolve').click()
    await expect.poll(() => saved().slides[0]!.comments.threads[0]!.status).toBe('resolved')
    // resolved: no marker for it any more
    await expect.element(page.getByTestId('pptx-comment-marker')).toHaveLength(1)
    expect(changedSinceOpen()).toEqual(['ppt/comments/modernComment_100_1.xml'])
  })

  it('places a comment at a clicked point on a slide without comments', async () => {
    await openComments()
    await page.getByTestId('pptx-thumb').nth(2).click()
    await page.getByTestId('pptx-comment-point').click()
    // Component tests run without Tailwind, so the click goes to the placing layer at a point measured on the slide.
    const box = document.querySelector('[data-testid="pptx-slide"]')!.getBoundingClientRect()
    page
      .getByTestId('pptx-comment-place')
      .element()
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: box.left + box.width / 4, clientY: box.top + box.height / 2 }))
    await expect.element(page.getByTestId('pptx-comment-pending')).toBeInTheDocument()
    await page.getByTestId('pptx-comment-text').fill('Picture here')
    await page.getByTestId('pptx-comment-post').click()
    await expect.poll(() => saved().slides[2]!.comments.threads.length).toBe(1)
    const pos = saved().slides[2]!.comments.threads[0]!.pos!
    expect(pos.x / 12192000).toBeCloseTo(0.25, 1)
    expect(pos.y / 6858000).toBeCloseTo(0.5, 1)
    await expect.element(page.getByTestId('pptx-comment-marker')).toHaveLength(1)
    const files = Object.keys(unzipSync(savedBytes()))
    expect(files).toContain('ppt/comments/modernComment_102_1.xml')
    expect(strFromU8(unzipSync(savedBytes())['[Content_Types].xml']!)).toContain('/ppt/comments/modernComment_102_1.xml')
  })

  it('comments on the selected shape', async () => {
    await openComments()
    await page.getByTestId('pptx-edit').click()
    await userEvent.click(document.querySelector('[data-testid="pptx-hit"][aria-label="Box"]')!)
    await page.getByTestId('pptx-comment-shape').click()
    await expect.element(page.getByTestId('pptx-comment-where')).toHaveTextContent('On “Box”')
    await page.getByTestId('pptx-comment-text').fill('Too wide')
    await page.getByTestId('pptx-comment-post').click()
    await expect.poll(() => saved().slides[0]!.comments.threads.at(-1)?.anchor).toEqual({ kind: 'shape', shape: '3' })
  })

  it('legacy comments show read-only; jumping from "All slides" goes to the slide', async () => {
    await openComments()
    await page.getByTestId('pptx-comments-all').click()
    await page.getByTestId('pptx-comments-group').nth(1).getByTestId('pptx-thread-jump').click()
    await expect.element(page.getByTestId('pptx-counter')).toHaveTextContent('Slide 2 of 3')
    await expect.element(page.getByTestId('pptx-thread-legacy')).toBeInTheDocument()
    expect(page.getByTestId('pptx-thread-reply').query()).toBeNull()
  })

  it('without a signed-in author, commenting is off and says so; nothing is written', async () => {
    await openComments({ ...props, author: undefined })
    await expect.element(page.getByTestId('pptx-comments-off')).toHaveTextContent('Commenting is off')
    expect(page.getByTestId('pptx-comment-new').query()).toBeNull()
    expect(page.getByTestId('pptx-thread-resolve').query()).toBeNull()
    await expect.element(page.getByTestId('pptx-thread')).toHaveLength(3)
    expect(api.acquireLock).not.toHaveBeenCalled()
  })

  it('without edit access, comments are read-only and the panel says why', async () => {
    await openComments({ ...props, canEdit: false })
    await expect.element(page.getByTestId('pptx-comments-off')).toHaveTextContent('needs edit access')
    expect(page.getByTestId('pptx-comment-new').query()).toBeNull()
  })
})
