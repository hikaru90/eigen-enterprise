import type { EmojiCatalog } from './emoji-catalog'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import EmojiPicker from './emoji-picker.svelte'
import { readRecentEmoji, rememberRecentEmoji } from './emoji-recent'

const small: EmojiCatalog = {
  groups: [
    {
      key: 'smileys-emotion',
      label: 'Smileys & emotion',
      emoji: [
        { emoji: '😀', label: 'grinning face', tags: ['face', 'grin'] },
        { emoji: '😂', label: 'face with tears of joy', tags: ['laugh'] },
        { emoji: '❤️', label: 'red heart', tags: ['love'] },
      ],
    },
    {
      key: 'animals-nature',
      label: 'Animals & nature',
      emoji: [
        { emoji: '🦒', label: 'giraffe', tags: ['spots'] },
        { emoji: '🐵', label: 'monkey face', tags: ['face', 'monkey'] },
      ],
    },
  ],
}

const props = (over: Record<string, unknown> = {}) => ({
  label: 'Pick a reaction',
  onpick: vi.fn(),
  onclose: vi.fn(),
  load: () => Promise.resolve(small),
  ...over,
})

describe('emoji-picker.svelte', () => {
  beforeEach(() => localStorage.clear())

  it('loads the real Unicode dataset lazily: every category, thousands of emoji', async () => {
    render(EmojiPicker, { label: 'Pick a reaction', onpick: vi.fn() })
    const picker = page.getByRole('dialog', { name: 'Pick a reaction' })
    await expect.element(picker.getByRole('button', { name: 'giraffe', exact: true })).toBeInTheDocument()
    const nav = picker.getByRole('navigation', { name: 'Emoji categories' })
    for (const name of ['Smileys & emotion', 'People & body', 'Animals & nature', 'Flags']) {
      await expect.element(nav.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(page.getByTestId('emoji-picker-emoji').elements().length).toBeGreaterThan(1800)
  })

  it('opens with the search focused; typing filters by name and keyword; clicking picks and is remembered', async () => {
    const onpick = vi.fn()
    render(EmojiPicker, props({ onpick }))
    const search = page.getByRole('searchbox', { name: 'Search emoji' })
    await expect.element(search).toHaveFocus()
    await userEvent.keyboard('face')
    await expect.element(page.getByRole('group', { name: 'Search results' })).toBeInTheDocument()
    expect(page.getByTestId('emoji-picker-emoji').elements().map((e) => e.getAttribute('data-emoji'))).toEqual(['😀', '😂', '🐵'])
    await page.getByRole('button', { name: 'monkey face' }).click()
    expect(onpick).toHaveBeenCalledWith('🐵')
    expect(readRecentEmoji()).toEqual(['🐵'])
  })

  it('says when nothing matches', async () => {
    render(EmojiPicker, props())
    await page.getByRole('searchbox', { name: 'Search emoji' }).fill('zebra')
    await expect.element(page.getByText('No emoji match “zebra”.')).toBeInTheDocument()
    expect(page.getByTestId('emoji-picker-emoji').elements()).toHaveLength(0)
  })

  it('shows recently used emoji first, from this browser', async () => {
    rememberRecentEmoji('🦒')
    rememberRecentEmoji('❤️')
    render(EmojiPicker, props())
    const recent = page.getByRole('group', { name: 'Recently used' })
    await expect.element(recent).toBeInTheDocument()
    expect(recent.getByTestId('emoji-picker-emoji').elements().map((e) => e.getAttribute('data-emoji'))).toEqual(['❤️', '🦒'])
    await expect.element(page.getByRole('navigation', { name: 'Emoji categories' }).getByRole('button', { name: 'Recently used' })).toBeInTheDocument()
  })

  it('a category button jumps to its section and marks it current', async () => {
    render(EmojiPicker, props())
    const tab = page.getByRole('navigation', { name: 'Emoji categories' }).getByRole('button', { name: 'Animals & nature' })
    await tab.click()
    await expect.element(tab).toHaveAttribute('aria-current', 'true')
  })

  it('keyboard: ↓ from the search enters the grid, arrows move, Enter picks; Enter in the search picks the first match; Esc closes', async () => {
    const onpick = vi.fn()
    const onclose = vi.fn()
    render(EmojiPicker, props({ onpick, onclose }))
    await expect.element(page.getByRole('searchbox', { name: 'Search emoji' })).toHaveFocus()
    await expect.element(page.getByRole('button', { name: 'grinning face' })).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(page.getByRole('button', { name: 'grinning face' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('button', { name: 'face with tears of joy' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onpick).toHaveBeenLastCalledWith('😂')

    await page.getByRole('searchbox', { name: 'Search emoji' }).fill('giraffe')
    await expect.element(page.getByRole('button', { name: /giraffe/i })).toBeVisible()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => onpick.mock.lastCall?.[0]).toBe('🦒')

    await userEvent.keyboard('{Escape}')
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('a dataset that fails to load says so', async () => {
    render(EmojiPicker, props({ load: () => Promise.reject(new Error('offline')) }))
    await expect.element(page.getByRole('alert')).toHaveTextContent('Couldn’t load the emoji list: offline')
  })
})
