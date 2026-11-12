import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { BROWSER_UNAVAILABLE_MESSAGE } from '../../../../../modules/brand/extract/capture-errors'
import { GUIDE_ACCEPT, GUIDE_LIMITS_TEXT } from '../../../../../modules/brand/extract/guide'
import SourceOptions from './source-options.svelte'

function setup(over: { captureError?: string; uploadError?: string; busy?: boolean } = {}) {
  const oncapture = vi.fn()
  const onupload = vi.fn()
  render(SourceOptions, {
    busy: over.busy ?? false,
    captureError: over.captureError ?? '',
    uploadError: over.uploadError ?? '',
    oncapture,
    onupload,
  })
  return { oncapture, onupload }
}

describe('brand extract: source options', () => {
  it('offers both sources side by side: the site URL and the brand guide upload', async () => {
    setup()
    await expect.element(page.getByTestId('extract-from-url')).toBeVisible()
    await expect.element(page.getByTestId('extract-from-guide')).toBeVisible()
    await expect.element(page.getByLabelText('Site URL')).toBeVisible()
    const picker = page.getByLabelText('Brand guide')
    await expect.element(picker).toHaveAttribute('type', 'file')
    await expect.element(picker).toHaveAttribute('accept', GUIDE_ACCEPT)
    await expect
      .element(page.getByTestId('extract-from-guide'))
      .toHaveTextContent(GUIDE_LIMITS_TEXT)
  })

  it('captures the typed URL', async () => {
    const { oncapture } = setup()
    const capture = page.getByRole('button', { name: 'Capture & propose' })
    await expect.element(capture).toBeDisabled()
    await page.getByLabelText('Site URL').fill(' https://kindred.example ')
    await capture.click()
    expect(oncapture).toHaveBeenCalledWith('https://kindred.example')
  })

  it('uploads the chosen guide', async () => {
    const { onupload } = setup()
    const upload = page.getByRole('button', { name: 'Upload & propose' })
    await expect.element(upload).toBeDisabled()
    const file = new File(['%PDF-1.7\n'], 'Kindred CI.pdf', { type: 'application/pdf' })
    await userEvent.upload(page.getByLabelText('Brand guide'), file)
    await upload.click()
    expect(onupload).toHaveBeenCalledTimes(1)
    expect((onupload.mock.calls[0][0] as File).name).toBe('Kindred CI.pdf')
  })

  it('shows the no-browser message in the URL option, with the upload right next to it', async () => {
    setup({ captureError: BROWSER_UNAVAILABLE_MESSAGE })
    const message = page.getByTestId('capture-error')
    await expect.element(message).toHaveTextContent(BROWSER_UNAVAILABLE_MESSAGE)
    await expect.element(message).toHaveAttribute('role', 'alert')
    expect(page.getByTestId('extract-from-url').element().contains(message.element())).toBe(true)
    await expect.element(page.getByRole('button', { name: 'Upload & propose' })).toBeVisible()
  })

  it('shows a refused upload in the upload option', async () => {
    setup({ uploadError: '“guide.pdf” is 12.0 MB; PDFs can be at most 10 MB.' })
    const message = page.getByTestId('upload-error')
    await expect
      .element(message)
      .toHaveTextContent('“guide.pdf” is 12.0 MB; PDFs can be at most 10 MB.')
    expect(page.getByTestId('extract-from-guide').element().contains(message.element())).toBe(true)
  })

  it('disables both actions while busy', async () => {
    setup({ busy: true })
    await expect.element(page.getByRole('button', { name: 'Working…' }).first()).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Working…' }).nth(1)).toBeDisabled()
  })
})
