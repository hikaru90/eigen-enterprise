import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MailKindsInfo from './mail-kinds-info.svelte'

describe('MailKindsInfo (the three kinds of mail, collapsed by default)', () => {
  it('shows only its button until opened', async () => {
    render(MailKindsInfo, { current: 'marketing' })
    await expect.element(page.getByRole('button', { name: 'Personal, transactional, marketing: what is the difference?' })).toBeVisible()
    await expect.element(page.getByTestId('mail-kinds-panel')).not.toBeInTheDocument()
  })

  it('opens to the three kinds with their rules, the current one marked', async () => {
    render(MailKindsInfo, { current: 'marketing' })
    await page.getByRole('button', { name: 'Personal, transactional, marketing: what is the difference?' }).click()
    const panel = page.getByTestId('mail-kinds-panel')
    await expect.element(panel).toBeVisible()
    await expect.element(panel).toHaveTextContent(/Personal mail/)
    await expect.element(panel).toHaveTextContent(/Transactional mail/)
    await expect.element(panel).toHaveTextContent(/Marketing mail/)
    await expect.element(panel).toHaveTextContent(/UWG §7/)
    await expect.element(panel).toHaveTextContent(/not legal advice/i)
    await expect.element(page.getByTestId('mail-kind-marketing')).toHaveAttribute('aria-current', 'true')
    await expect.element(page.getByTestId('mail-kind-personal')).not.toHaveAttribute('aria-current')
  })
})
