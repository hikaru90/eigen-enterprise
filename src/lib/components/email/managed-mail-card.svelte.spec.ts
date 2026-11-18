import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ManagedMailCard from './managed-mail-card.svelte'

describe('ManagedMailCard (eigenEnterprise Mail account, no keys)', () => {
  it('shows the provider, region and default sender, no sandbox or key wording', async () => {
    render(ManagedMailCard, { region: 'eu-central-1', sender: 'hello@kindred.test', paused: false })
    const card = page.getByTestId('email-managed-account')
    await expect.element(card).toHaveTextContent(/eigenEnterprise Mail/)
    await expect.element(card).toHaveTextContent(/eu-central-1/)
    await expect.element(card).toHaveTextContent(/hello@kindred\.test/)
    await expect.element(card).not.toHaveTextContent(/sandbox|IAM|access key/i)
    await expect.element(page.getByTestId('email-managed-paused')).not.toBeInTheDocument()
  })

  it('says plainly when sending is paused, and when there is no sender yet', async () => {
    render(ManagedMailCard, { region: 'eu-central-1', sender: '', paused: true })
    await expect.element(page.getByTestId('email-managed-paused')).toHaveTextContent(
      'Sending is paused because too many mails bounced or were marked as spam. Contact support.',
    )
    await expect.element(page.getByTestId('email-managed-account')).toHaveTextContent(/None yet/)
  })
})
