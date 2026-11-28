import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import CommentsPanel from './comments-panel.svelte'
import { openDeck } from './model'
import { commentedPptx } from './test-utils/comment-fixtures'

const slides = openDeck(commentedPptx()).deck.slides

function props(over: Record<string, unknown> = {}) {
  return {
    slides,
    current: 0,
    me: 'm-bob',
    canComment: true,
    offReason: null,
    selectedShape: null,
    pending: null,
    focused: null,
    placing: false,
    deckError: null,
    onstart: vi.fn(),
    onpost: vi.fn(async () => true),
    oncancel: vi.fn(),
    onreply: vi.fn(async () => true),
    onedit: vi.fn(async () => true),
    onstatus: vi.fn(async () => true),
    ondelete: vi.fn(async () => true),
    onjump: vi.fn(),
    onclose: vi.fn(),
    ...over,
  }
}

const threads = () => page.getByTestId('pptx-thread')

describe('comments panel', () => {
  it('shows the slide’s threads with authors, replies, status and anchors, and says that legacy comments were left out', async () => {
    render(CommentsPanel, props())
    await expect.element(threads()).toHaveLength(3)
    await expect.element(threads().nth(0).getByTestId('pptx-thread-author')).toHaveTextContent('Alice Smith')
    await expect.element(threads().nth(0).getByTestId('pptx-thread-text')).toHaveTextContent('Check the numbers before Friday')
    await expect.element(threads().nth(0).getByTestId('pptx-reply')).toHaveLength(2)
    await expect.element(threads().nth(1).getByTestId('pptx-thread-resolved')).toBeInTheDocument()
    await expect.element(threads().nth(1)).toHaveTextContent('On “Box”')
    await expect.element(threads().nth(2)).toHaveTextContent('On text in “Box”')
    await expect.element(page.getByTestId('pptx-legacy-ignored')).toHaveTextContent('2 older-format comments')
  })

  it('offers edit and delete only on your own comments and replies; reply and resolve on every thread', async () => {
    const p = props()
    render(CommentsPanel, p)
    const alice = threads().nth(0)
    const bobs = threads().nth(1)
    expect(alice.getByTestId('pptx-thread-edit').query()).toBeNull()
    expect(alice.getByTestId('pptx-thread-delete').query()).toBeNull()
    await expect.element(alice.getByTestId('pptx-thread-resolve')).toBeInTheDocument()
    await expect.element(bobs.getByTestId('pptx-thread-reopen')).toBeInTheDocument()
    await expect.element(bobs.getByTestId('pptx-thread-edit')).toBeInTheDocument()
    // Bob's reply on Alice's thread is his to edit; Alice's is not
    await expect.element(alice.getByTestId('pptx-reply-edit')).toHaveLength(1)

    await alice.getByTestId('pptx-thread-reply').click()
    await alice.getByTestId('pptx-reply-text-input').fill('Will do')
    await alice.getByTestId('pptx-reply-send').click()
    expect(p.onreply).toHaveBeenCalledWith('/ppt/slides/slide1.xml', '{C1}', 'Will do')

    await bobs.getByTestId('pptx-thread-reopen').click()
    expect(p.onstatus).toHaveBeenCalledWith('/ppt/slides/slide1.xml', '{C2}', 'active')

    await bobs.getByTestId('pptx-thread-edit').click()
    await bobs.getByTestId('pptx-comment-edit-text').fill('Much bigger')
    await bobs.getByTestId('pptx-comment-save').click()
    expect(p.onedit).toHaveBeenCalledWith('/ppt/slides/slide1.xml', '{C2}', null, 'Much bigger')

    await threads().nth(2).getByTestId('pptx-thread-delete').click()
    expect(p.ondelete).toHaveBeenCalledWith('/ppt/slides/slide1.xml', '{C3}', null)
  })

  it('starts new comments on the slide, at a point, or on the selected shape; writes and posts them', async () => {
    const p = props({ selectedShape: { id: '3', name: 'Box' } })
    const r = render(CommentsPanel, p)
    await page.getByTestId('pptx-comment-new').click()
    expect(p.onstart).toHaveBeenLastCalledWith('slide')
    await page.getByTestId('pptx-comment-point').click()
    expect(p.onstart).toHaveBeenLastCalledWith('point')
    await page.getByTestId('pptx-comment-shape').click()
    expect(p.onstart).toHaveBeenLastCalledWith('shape')
    await r.rerender({ ...p, pending: { label: 'On “Box”' } })
    await expect.element(page.getByTestId('pptx-comment-where')).toHaveTextContent('On “Box”')
    await expect.element(page.getByTestId('pptx-comment-post')).toBeDisabled()
    await page.getByTestId('pptx-comment-text').fill('Looks off')
    await page.getByTestId('pptx-comment-post').click()
    expect(p.onpost).toHaveBeenCalledWith('Looks off')
  })

  it('"All slides" groups every slide’s comments, marks legacy ones read-only, and jumps to one', async () => {
    const p = props()
    render(CommentsPanel, p)
    await page.getByTestId('pptx-comments-all').click()
    await expect.element(page.getByTestId('pptx-comments-group')).toHaveLength(2)
    const legacy = page.getByTestId('pptx-comments-group').nth(1).getByTestId('pptx-thread')
    await expect.element(legacy.getByTestId('pptx-thread-legacy')).toHaveTextContent('Older-format comment, read-only')
    await legacy.getByTestId('pptx-thread-jump').click()
    expect(p.onjump).toHaveBeenCalledWith(1, slides[1]!.comments.threads[0]!.id)
  })

  it('legacy threads have no actions, and when commenting is off the panel says why and offers none', async () => {
    render(CommentsPanel, props({ current: 1 }))
    await expect.element(threads()).toHaveLength(1)
    expect(threads().getByTestId('pptx-thread-reply').query()).toBeNull()
    expect(threads().getByTestId('pptx-thread-resolve').query()).toBeNull()
  })

  it('commenting off: the reason, no new-comment or thread actions', async () => {
    render(CommentsPanel, props({ canComment: false, offReason: 'Commenting is off here.' }))
    await expect.element(page.getByTestId('pptx-comments-off')).toHaveTextContent('Commenting is off here.')
    expect(page.getByTestId('pptx-comment-new').query()).toBeNull()
    expect(page.getByTestId('pptx-thread-reply').query()).toBeNull()
    expect(page.getByTestId('pptx-thread-edit').query()).toBeNull()
  })

  it('a slide without comments says so; Shift+Enter breaks the line, Enter posts', async () => {
    const p = props({ current: 2, pending: { label: 'On this slide' } })
    render(CommentsPanel, p)
    await expect.element(page.getByTestId('pptx-comments-none')).toHaveTextContent('No comments on this slide.')
    await page.getByTestId('pptx-comment-text').fill('Hi')
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}')
    expect(p.onpost).not.toHaveBeenCalled()
    await userEvent.keyboard('there{Enter}')
    expect(p.onpost).toHaveBeenCalledWith('Hi\nthere')
  })
})
