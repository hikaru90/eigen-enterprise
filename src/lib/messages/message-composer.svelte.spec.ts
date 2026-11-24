import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import MessageComposer from './message-composer.svelte'

const props = (over: Record<string, unknown> = {}) => ({
  placeholder: 'Message #general',
  label: 'Message',
  canSend: true,
  emoji: ['👍', '🎉'],
  inputTestid: 'composer',
  sendTestid: 'send',
  onsend: vi.fn(),
  ...over,
})

describe('message-composer.svelte', () => {
  it('Shift+Enter is a new line in the text, Enter sends', async () => {
    const onsend = vi.fn()
    render(MessageComposer, props({ onsend }))
    const input = page.getByTestId('composer')
    await input.click()
    await userEvent.keyboard('Hallo{Shift>}{Enter}{Enter}{/Shift}wie geht’s?')
    await expect.element(input).toHaveValue('Hallo\n\nwie geht’s?')
    expect(onsend).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onsend).toHaveBeenCalledOnce()
  })

  it('reports every change the person makes — typing, an emoji, a format — so the draft can be kept', async () => {
    const ondraft = vi.fn()
    render(MessageComposer, props({ ondraft }))
    const input = page.getByTestId('composer')
    await input.click()
    await userEvent.keyboard('hi')
    expect(ondraft).toHaveBeenLastCalledWith('hi')
    await page.getByTestId('composer-emoji').click()
    await page.getByRole('menuitem', { name: 'Insert 🎉' }).click()
    expect(ondraft).toHaveBeenLastCalledWith('hi🎉')
    await page.getByTestId('composer-format-bold').click()
    expect(ondraft).toHaveBeenLastCalledWith('hi🎉****')
  })

  it('"More emoji" opens the full picker; the picked emoji goes in at the cursor', async () => {
    localStorage.clear()
    const ondraft = vi.fn()
    render(MessageComposer, props({ ondraft }))
    await page.getByTestId('composer').click()
    await userEvent.keyboard('hi ')
    await page.getByTestId('composer-emoji').click()
    await page.getByRole('menuitem', { name: 'More emoji' }).click()
    const picker = page.getByRole('dialog', { name: 'Insert emoji' })
    await picker.getByRole('searchbox', { name: 'Search emoji' }).fill('giraffe')
    // The dataset loads lazily: wait for the match before Enter picks it.
    await expect.element(picker.getByRole('button', { name: /giraffe/i })).toBeVisible()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => ondraft.mock.lastCall?.[0]).toBe('hi 🦒')
    expect(page.getByRole('dialog', { name: 'Insert emoji' }).elements()).toHaveLength(0)
    await expect.element(page.getByTestId('composer')).toHaveFocus()
  })

  it('opens with a restored draft', async () => {
    render(MessageComposer, props({ value: 'halb fertig\nzweite Zeile' }))
    await expect.element(page.getByTestId('composer')).toHaveValue('halb fertig\nzweite Zeile')
  })

  it('inserts a Drive folder Markdown link at the caret when driveFolders is enabled, and omits the button otherwise', async () => {
    const ondraft = vi.fn()
    const folders = [
      { id: 'f1', name: 'Q4 Docs', pathLabel: 'My drive', href: '/drive/folder/f1' },
      { id: 'f2', name: 'Design', pathLabel: 'Shared with me', href: '/drive/folder/f2' },
    ]
    const r = render(
      MessageComposer,
      props({
        driveFolders: true,
        loadDriveFolders: async () => folders,
        ondraft,
      }),
    )
    const input = page.getByTestId('composer')
    await input.click()
    await userEvent.keyboard('Check ')
    await page.getByTestId('composer-drive-folder').click()
    const picker = page.getByRole('dialog', { name: 'Link a Drive folder' })
    await expect.element(picker).toBeVisible()
    await picker.getByRole('option', { name: /Q4 Docs/ }).click()
    await expect.element(input).toHaveValue('Check [Q4 Docs](/drive/folder/f1)')
    expect(ondraft).toHaveBeenLastCalledWith('Check [Q4 Docs](/drive/folder/f1)')
    expect(page.getByRole('dialog', { name: 'Link a Drive folder' }).elements()).toHaveLength(0)
    await expect.element(input).toHaveFocus()

    await page.getByTestId('composer-drive-folder').click()
    await expect.element(page.getByRole('dialog', { name: 'Link a Drive folder' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(page.getByRole('dialog', { name: 'Link a Drive folder' }).elements()).toHaveLength(0)
    await expect.element(input).toHaveFocus()

    r.unmount()
    render(MessageComposer, props())
    expect(page.getByTestId('composer-drive-folder').elements()).toHaveLength(0)
  })
})

describe('message-composer.svelte: @ suggestions', () => {
  const mentionables = [
    { id: 'me', name: 'Olga Owner', handle: 'olga', kind: 'human' as const },
    { id: 'cw', name: 'Nova Lee', handle: 'nova-mwujrl74', kind: 'coworker' as const },
    { id: 'noah', name: 'Noah Novak', handle: 'nn', kind: 'human' as const },
    { id: 'bea', name: 'Bea Marquez', handle: 'bea.m', kind: 'human' as const },
  ]
  const list = () => page.getByRole('listbox', { name: 'People and co-workers to mention' })

  it('typing @ and letters lists the matching members: co-workers with their AI mark and handle, never the writer', async () => {
    render(MessageComposer, props({ mentionables, me: 'me' }))
    const input = page.getByRole('combobox', { name: 'Message' })
    await input.click()
    await userEvent.keyboard('hi @')
    expect(list().elements()).toHaveLength(0)
    await expect.element(input).toHaveAttribute('aria-expanded', 'false')
    await userEvent.keyboard('no')
    await expect.element(list()).toBeVisible()
    await expect.element(input).toHaveAttribute('aria-expanded', 'true')
    const options = list().getByRole('option')
    expect(options.elements()).toHaveLength(2)
    const nova = list().getByRole('option', { name: /Nova Lee/ })
    await expect.element(nova.getByTestId('ai-mark')).toBeVisible()
    await expect.element(nova).toHaveTextContent('@nova-mwujrl74')
    expect(list().getByRole('option', { name: /Olga/ }).elements()).toHaveLength(0)
    // The first is active, and the box says so.
    const first = options.elements()[0]
    expect(first.getAttribute('aria-selected')).toBe('true')
    await expect.element(input).toHaveAttribute('aria-activedescendant', first.id)
    await expect.element(input).toHaveAttribute('aria-controls', list().element().id)
  })

  it('↑/↓ move, Enter inserts the exact handle and a space — and does not send', async () => {
    const onsend = vi.fn()
    const ondraft = vi.fn()
    render(MessageComposer, props({ mentionables, me: 'me', onsend, ondraft }))
    const input = page.getByTestId('composer')
    await input.click()
    await userEvent.keyboard('ask @nov')
    // "nov": Nova (handle, first name) before Noah (last name).
    await expect.element(list().getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(list().getByRole('option', { name: /Noah Novak/ })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowUp}')
    await expect.element(list().getByRole('option', { name: /Nova Lee/ })).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Enter}')
    await expect.element(input).toHaveValue('ask @nova-mwujrl74 ')
    expect(onsend).not.toHaveBeenCalled()
    expect(ondraft).toHaveBeenLastCalledWith('ask @nova-mwujrl74 ')
    expect(list().elements()).toHaveLength(0)
    await userEvent.keyboard('hello{Enter}')
    expect(onsend).toHaveBeenCalledOnce()
  })

  it('Tab inserts a person by their handle; Esc closes without inserting', async () => {
    render(MessageComposer, props({ mentionables, me: 'me' }))
    const input = page.getByTestId('composer')
    await input.click()
    await userEvent.keyboard('@marq')
    await expect.element(list().getByRole('option', { name: /Bea Marquez/ })).toBeVisible()
    await userEvent.keyboard('{Tab}')
    await expect.element(input).toHaveValue('@bea.m ')
    await expect.element(input).toHaveFocus()
    await userEvent.keyboard('and @no')
    await expect.element(list()).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(list().elements()).toHaveLength(0)
    await expect.element(input).toHaveValue('@bea.m and @no')
  })

  it('a click on a member inserts them at the @word', async () => {
    render(MessageComposer, props({ mentionables, me: 'me' }))
    const input = page.getByTestId('composer')
    await input.click()
    await userEvent.keyboard('@n')
    await list().getByRole('option', { name: /Noah Novak/ }).click()
    await expect.element(input).toHaveValue('@nn ')
    await expect.element(input).toHaveFocus()
  })

  it('without members to mention it is a plain box: Enter sends', async () => {
    const onsend = vi.fn()
    render(MessageComposer, props({ onsend }))
    await page.getByTestId('composer').click()
    await userEvent.keyboard('@nov{Enter}')
    expect(list().elements()).toHaveLength(0)
    expect(onsend).toHaveBeenCalledOnce()
  })
})
