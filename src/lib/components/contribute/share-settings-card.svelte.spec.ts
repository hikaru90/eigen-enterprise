import type { ShareStatusView } from '../../../../modules/contribute/share/service'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { SHARED_FIELDS } from '$lib/contribute/share-fields'
import ShareSettingsCard from './share-settings-card.svelte'

vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

const status = (over: Partial<ShareStatusView> = {}): ShareStatusView => ({
  enabled: true,
  notConfigured: null,
  revoked: null,
  providerReady: true,
  waiting: 2,
  sent: 5,
  failed: 0,
  withdrawing: 0,
  lastError: null,
  ...over,
})

describe('share-settings-card.svelte', () => {
  // share-fields.spec.ts (node) pins SHARED_FIELDS to the contract's keys.
  it('lists exactly the fields that are sent, says what never is, and where sending stands', async () => {
    render(ShareSettingsCard, { status: status(), result: null })
    await expect.element(page.getByText('Share proposals with the eigenEnterprise makers')).toBeInTheDocument()
    await expect.element(page.getByTestId('share-enabled')).toHaveTextContent('On')
    const fields = page.getByTestId('share-fields').element().querySelectorAll('li')
    expect([...fields].map((li) => li.textContent?.trim())).toEqual(Object.values(SHARED_FIELDS))
    await expect.element(page.getByText('Who proposed or voted, names, emails')).toBeInTheDocument()
    await expect.element(page.getByTestId('share-counts')).toHaveTextContent('2 proposals waiting · 5 shared')
    expect(page.getByTestId('share-not-configured').elements()).toHaveLength(0)
    await expect.element(page.getByTestId('share-toggle')).toHaveTextContent('Turn sharing off')
  })

  it('names each reason nothing goes out: not configured, refused, no AI provider, the last error', async () => {
    render(ShareSettingsCard, {
      status: status({
        notConfigured: 'not set',
        revoked: { at: '2026-11-13T10:00:00Z', message: 'refused' },
        providerReady: false,
        failed: 1,
        withdrawing: 1,
        lastError: { message: 'The central board answered HTTP 503', at: '2026-11-13T10:00:00Z' },
      }),
      result: null,
    })
    await expect.element(page.getByTestId('share-not-configured')).toHaveTextContent('central board is not configured')
    await expect.element(page.getByTestId('share-revoked')).toHaveTextContent('refused this install')
    await expect.element(page.getByTestId('share-no-provider')).toHaveTextContent('No AI provider is connected')
    await expect.element(page.getByTestId('share-counts')).toHaveTextContent('1 failed')
    await expect.element(page.getByTestId('share-counts')).toHaveTextContent('1 being withdrawn')
    await expect.element(page.getByTestId('share-last-error')).toHaveTextContent('HTTP 503')
  })

  it('off: offers to turn it on; on: turning off can also delete what was sent', async () => {
    const off = render(ShareSettingsCard, { status: status({ enabled: false }), result: null })
    await expect.element(page.getByTestId('share-enabled')).toHaveTextContent('Off')
    await expect.element(page.getByTestId('share-toggle')).toHaveTextContent('Turn sharing on')
    expect(page.getByTestId('share-withdraw').elements()).toHaveLength(0)
    expect((off.container.querySelector('input[name="enabled"]') as HTMLInputElement).value).toBe('on')
    off.unmount()

    const on = render(ShareSettingsCard, { status: status(), result: { error: 'Sharing is off. Deleting from the central board failed.' } })
    expect((on.container.querySelector('input[name="enabled"]') as HTMLInputElement).value).toBe('off')
    await page.getByTestId('share-withdraw').click()
    await expect.element(page.getByTestId('share-toggle')).toHaveTextContent('Turn off and delete what was sent')
    await expect.element(page.getByRole('alert')).toHaveTextContent('Deleting from the central board failed')
  })
})
