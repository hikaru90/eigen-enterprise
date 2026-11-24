import type { DriveFolderOption } from './composer'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import DriveFolderPicker from './drive-folder-picker.svelte'

const sample: DriveFolderOption[] = [
  { id: 'f1', name: 'Q4 Planning', pathLabel: 'My drive', href: '/drive/folder/f1' },
  { id: 'f2', name: 'Designs', pathLabel: 'Shared with me', href: '/drive/folder/f2' },
  { id: 'f3', name: '#general', pathLabel: 'Messages', href: '/drive/folder/f3' },
]

describe('drive-folder-picker.svelte', () => {
  it('focuses the searchbox on mount, loads initial folders, and displays name + pathLabel', async () => {
    const load = vi.fn(async () => sample)
    render(DriveFolderPicker, { onpick: vi.fn(), onclose: vi.fn(), load })

    const search = page.getByRole('searchbox', { name: 'Search Drive folders' })
    await expect.element(search).toHaveFocus()
    expect(load).toHaveBeenCalledWith('', expect.any(AbortSignal))

    const options = page.getByTestId('drive-folder-option')
    await expect.element(options.first()).toBeVisible()
    expect(options.elements()).toHaveLength(3)
    await expect.element(options.nth(0)).toHaveTextContent('Q4 Planning')
    await expect.element(options.nth(0)).toHaveTextContent('My drive')
    await expect.element(options.nth(1)).toHaveTextContent('Designs')
    await expect.element(options.nth(1)).toHaveTextContent('Shared with me')
  })

  it('filters folders via debounced search and shows empty state when none match', async () => {
    const load = vi.fn(async (q: string) =>
      q.trim() ? sample.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase())) : sample,
    )
    render(DriveFolderPicker, { onpick: vi.fn(), onclose: vi.fn(), load })
    await expect.element(page.getByTestId('drive-folder-option').first()).toBeVisible()

    const search = page.getByRole('searchbox', { name: 'Search Drive folders' })
    await search.fill('des')
    await expect.poll(() => load.mock.calls.some(([q]) => q === 'des')).toBe(true)
    expect(page.getByTestId('drive-folder-option').elements()).toHaveLength(1)
    await expect.element(page.getByTestId('drive-folder-option').first()).toHaveTextContent('Designs')

    await search.fill('nonexistent')
    await expect.poll(() => load.mock.calls.some(([q]) => q === 'nonexistent')).toBe(true)
    await expect.element(page.getByText(/No Drive folders match/)).toBeVisible()
    expect(page.getByTestId('drive-folder-option').elements()).toHaveLength(0)
  })

  it('clicking a folder calls onpick with the folder', async () => {
    const onpick = vi.fn()
    render(DriveFolderPicker, {
      onpick,
      onclose: vi.fn(),
      load: async () => sample,
    })
    await page.getByRole('option', { name: /Designs/ }).click()
    expect(onpick).toHaveBeenCalledWith(sample[1])
  })

  it('supports keyboard navigation (ArrowDown/ArrowUp/Enter) and Escape to close', async () => {
    const onpick = vi.fn()
    const onclose = vi.fn()
    render(DriveFolderPicker, {
      onpick,
      onclose,
      load: async () => sample,
    })
    await expect.element(page.getByTestId('drive-folder-option').first()).toBeVisible()
    await userEvent.keyboard('{ArrowDown}')
    await expect
      .element(page.getByRole('option', { name: /Designs/ }))
      .toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowUp}')
    await expect
      .element(page.getByRole('option', { name: /Q4 Planning/ }))
      .toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onpick).toHaveBeenCalledWith(sample[1])

    await userEvent.keyboard('{Escape}')
    expect(onclose).toHaveBeenCalledOnce()
  })

  it('renders an ErrorNotice alert when loading fails', async () => {
    render(DriveFolderPicker, {
      onpick: vi.fn(),
      onclose: vi.fn(),
      load: async () => {
        throw new Error('Drive unavailable')
      },
    })
    await expect.element(page.getByRole('alert')).toHaveTextContent('Drive unavailable')
  })
})
