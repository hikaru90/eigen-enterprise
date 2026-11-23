import type { OfficeViewerModule } from './viewers'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import OfficeViewerLoader from './office-viewer-loader.svelte'

const viewerProps = { fileId: 'f1', name: 'Offer.pdf', canEdit: false, heartbeatMs: 30_000 }
const chunkGone = () =>
  Promise.reject<OfficeViewerModule>(
    new TypeError('Failed to fetch dynamically imported module: https://one.example/_app/immutable/chunks/BXNSwe4O.js'),
  )

describe('office-viewer-loader.svelte', () => {
  it('after a new release, a viewer whose chunk is gone says so in a sentence and offers Reload', async () => {
    const reload = vi.fn()
    render(OfficeViewerLoader, { load: chunkGone, viewerProps, check: async () => true, reload })
    const notice = page.getByTestId('drive-office-error')
    await expect.element(notice).toHaveTextContent('eigenEnterprise was updated — reload to open this.')
    await expect.element(notice).not.toHaveTextContent('Failed to fetch')
    await page.getByRole('button', { name: 'Reload' }).click()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('on the current version, a failed load shows its real error and no Reload', async () => {
    render(OfficeViewerLoader, { load: chunkGone, viewerProps, check: async () => false, reload: vi.fn() })
    const notice = page.getByTestId('drive-office-error')
    await expect
      .element(notice)
      .toHaveTextContent(
        'The viewer could not be loaded: Failed to fetch dynamically imported module: https://one.example/_app/immutable/chunks/BXNSwe4O.js',
      )
    await expect.element(notice).not.toHaveTextContent('was updated')
    expect(page.getByRole('button', { name: 'Reload' }).elements()).toHaveLength(0)
  })

  it('says it is opening the file while the viewer loads', async () => {
    render(OfficeViewerLoader, {
      load: () => new Promise<OfficeViewerModule>(() => {}),
      viewerProps,
      check: async () => false,
      reload: vi.fn(),
    })
    await expect.element(page.getByTestId('drive-office-loading')).toHaveTextContent('Opening Offer.pdf…')
  })
})
