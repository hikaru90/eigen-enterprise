import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import DeleteButton from './temporal-event-delete-button.svelte'

describe('Tasks row trash: delete for good, after a confirmation', () => {
  it('says it deletes for good and asks before it does', async () => {
    const onConfirm = vi.fn()
    render(DeleteButton, { summary: 'Call the therapist', onConfirm })

    await page.getByRole('button', { name: 'Delete for good' }).click()
    const dialog = page.getByRole('alertdialog')
    await expect.element(dialog).toHaveTextContent(/Delete this for good\?/)
    await expect
      .element(dialog)
      .toHaveTextContent(/“Call the therapist” and the thought it came from/)
    await expect.element(dialog).toHaveTextContent(/can’t be undone/)
    expect(onConfirm).not.toHaveBeenCalled()

    await dialog.getByRole('button', { name: 'Delete' }).click()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await expect.element(dialog).not.toBeInTheDocument()
  })

  it('cancel keeps the row', async () => {
    const onConfirm = vi.fn()
    render(DeleteButton, { summary: 'Call the therapist', onConfirm })

    await page.getByRole('button', { name: 'Delete for good' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(page.getByRole('alertdialog')).not.toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
