import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import MessageEdit from './message-edit.svelte'

describe('message-edit.svelte', () => {
  it('keeps the message’s line breaks: seeded with them, Shift+Enter adds one, Enter saves them all', async () => {
    const onsave = vi.fn()
    render(MessageEdit, { body: 'Hallo\n\nwie geht’s?', onsave, oncancel: vi.fn() })
    const input = page.getByTestId('messages-edit-input')
    await expect.element(input).toHaveValue('Hallo\n\nwie geht’s?')
    await input.click()
    ;(input.element() as HTMLTextAreaElement).setSelectionRange(100, 100)
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}Grüße')
    expect(onsave).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(onsave).toHaveBeenCalledWith('Hallo\n\nwie geht’s?\nGrüße')
  })
})
