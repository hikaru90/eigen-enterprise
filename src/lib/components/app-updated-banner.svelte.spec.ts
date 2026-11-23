import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { appUpdate } from '$lib/app-update/state.svelte'
import AppUpdatedBanner from './app-updated-banner.svelte'
import AppUpdatedNotice from './app-updated-notice.svelte'

afterEach(() => {
  appUpdate.detected = false
})

describe('app-updated-banner.svelte', () => {
  it('stays away until a load failed after an update', async () => {
    render(AppUpdatedBanner, { reload: vi.fn() })
    expect(page.getByTestId('app-updated-banner').elements()).toHaveLength(0)
  })

  it('after an update, says so once with Reload', async () => {
    const reload = vi.fn()
    appUpdate.detected = true
    render(AppUpdatedBanner, { reload })
    await expect
      .element(page.getByTestId('app-updated-banner'))
      .toHaveTextContent('eigenEnterprise was updated — reload to open this.')
    await page.getByRole('button', { name: 'Reload' }).click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('yields to an inline notice where the load failed', async () => {
    appUpdate.detected = true
    render(AppUpdatedBanner, { reload: vi.fn() })
    render(AppUpdatedNotice, { reload: vi.fn(), testid: 'inline' })
    await expect.element(page.getByTestId('inline')).toBeInTheDocument()
    await expect.poll(() => page.getByTestId('app-updated-banner').elements().length).toBe(0)
  })
})
