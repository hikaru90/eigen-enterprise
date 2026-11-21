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
    await userEvent.keyboard('{Enter}')
    expect(ondraft).toHaveBeenLastCalledWith('hi 🦒')
    expect(page.getByRole('dialog', { name: 'Insert emoji' }).elements()).toHaveLength(0)
    await expect.element(page.getByTestId('composer')).toHaveFocus()
  })

  it('opens with a restored draft', async () => {
    render(MessageComposer, props({ value: 'halb fertig\nzweite Zeile' }))
    await expect.element(page.getByTestId('composer')).toHaveValue('halb fertig\nzweite Zeile')
  })
})
