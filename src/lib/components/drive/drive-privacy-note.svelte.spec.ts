import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import DrivePrivacyNote from './drive-privacy-note.svelte'

describe('DrivePrivacyNote', () => {
  it('states who can see an unshared folder, the sharing options and the agent caveat', async () => {
    render(DrivePrivacyNote)
    const note = page.getByRole('note', { name: 'Who can see your Drive' })
    await expect.element(note).toBeVisible()
    await expect.element(note).toHaveTextContent(/only you, the company owner and admins/i)
    await expect.element(note).toHaveTextContent(/specific people, a group or the whole company/i)
    await expect.element(note).toHaveTextContent(/view, edit or manage/i)
    await expect.element(note).toHaveTextContent(/everything inside it/i)
    await expect.element(note).toHaveTextContent(/agent can read/i)
    await expect.element(note).toHaveTextContent(/hidden from the owner and admins/i)
  })

  it('can be dismissed', async () => {
    render(DrivePrivacyNote)
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect.element(page.getByRole('note', { name: 'Who can see your Drive' })).not.toBeInTheDocument()
  })
})
