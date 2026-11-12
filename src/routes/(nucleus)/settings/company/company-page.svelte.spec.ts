import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CompanyPage from './+page.svelte'

const { applyActionMock, deserializeMock, invalidateAllMock } = vi.hoisted(() => ({
  applyActionMock: vi.fn(),
  deserializeMock: vi.fn(),
  invalidateAllMock: vi.fn(),
}))

vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy: () => undefined }),
  applyAction: applyActionMock,
  deserialize: deserializeMock,
}))

vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))

const props = (company: { name: string | null; logo: { url: string; mime: string } | null }, form: unknown = null) =>
  ({ data: { company }, form, params: {} }) as never

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'logo.png', { type: 'image/png' })

function files(...list: File[]): DataTransfer {
  const dt = new DataTransfer()
  for (const f of list) dt.items.add(f)
  return dt
}

/** A fetch that answers only when the test says so, so the in-flight state is observable. */
function pendingFetch() {
  let answer: (body: string) => void = () => undefined
  const fn = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        answer = (body) => resolve(new Response(body, { status: 200 }))
      }),
  )
  vi.stubGlobal('fetch', fn)
  return { fn, answer: (body: string) => answer(body) }
}

function uploadedFile(fn: ReturnType<typeof vi.fn>): File {
  expect(fn).toHaveBeenCalledTimes(1)
  const [url, init] = fn.mock.calls[0] as [string, RequestInit]
  expect(url).toBe('?/uploadLogo')
  expect(init.method).toBe('POST')
  expect(new Headers(init.headers).get('x-sveltekit-action')).toBe('true')
  const logo = (init.body as FormData).get('logo')
  expect(logo).toBeInstanceOf(File)
  return logo as File
}

beforeEach(() => {
  applyActionMock.mockReset().mockResolvedValue(undefined)
  deserializeMock.mockReset().mockImplementation((text: string) => JSON.parse(text))
  invalidateAllMock.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Settings → Company page', () => {
  it('edits the current name and offers an upload while there is no logo', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    await expect.element(page.getByTestId('company-name-input')).toHaveValue('Kindred')
    await expect.element(page.getByTestId('company-logo-initial')).toHaveTextContent('K')
    await expect.element(page.getByTestId('company-logo-upload')).toHaveTextContent('Upload logo')
    await expect.element(page.getByTestId('company-logo-remove')).not.toBeInTheDocument()
    await expect
      .element(page.getByTestId('company-logo-file'))
      .toHaveAttribute('accept', 'image/png,image/jpeg,image/svg+xml,image/webp')
  })

  it('shows the logo with Replace and Remove once there is one', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: { url: '/api/company/logo/abc', mime: 'image/png' } }))
    await expect.element(page.getByTestId('company-logo-preview')).toHaveAttribute('src', '/api/company/logo/abc')
    await expect.element(page.getByTestId('company-logo-upload')).toHaveTextContent('Replace logo')
    await expect.element(page.getByTestId('company-logo-remove')).toBeInTheDocument()
  })

  it('says why an upload was refused, next to the logo', async () => {
    render(
      CompanyPage,
      props({ name: 'Kindred', logo: null }, { action: 'uploadLogo', error: 'This SVG contains scripts.' }),
    )
    await expect.element(page.getByTestId('company-logo').getByRole('alert')).toHaveTextContent('This SVG contains scripts.')
  })

  it('the Replace logo button opens the file picker (it is not a submit that needs a file first)', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: { url: '/api/company/logo/abc', mime: 'image/png' } }))
    const input = page.getByTestId('company-logo-file').element() as HTMLInputElement
    const opened = vi.spyOn(input, 'click').mockImplementation(() => undefined)
    const button = page.getByTestId('company-logo-upload')
    await expect.element(button).toHaveAttribute('type', 'button')
    expect(input.required).toBe(false)
    await button.click()
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('uploads as soon as a file is picked, shows it is uploading, then applies the result', async () => {
    const { fn, answer } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const input = page.getByTestId('company-logo-file').element() as HTMLInputElement
    const file = png()
    input.files = files(file).files
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.png')
    await expect.element(page.getByTestId('company-logo-upload')).toBeDisabled()
    expect(uploadedFile(fn).name).toBe('logo.png')

    answer(JSON.stringify({ type: 'success', status: 200, data: { action: 'uploadLogo', ok: true } }))
    await vi.waitFor(() => expect(applyActionMock).toHaveBeenCalledTimes(1))
    expect(applyActionMock).toHaveBeenCalledWith({ type: 'success', status: 200, data: { action: 'uploadLogo', ok: true } })
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
    await expect.element(page.getByTestId('company-logo-status')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('company-logo-upload')).toBeEnabled()
  })

  it('applies a refused upload without reloading, so the reason shows', async () => {
    const { answer } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const input = page.getByTestId('company-logo-file').element() as HTMLInputElement
    input.files = files(png()).files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const failure = { type: 'failure', status: 400, data: { action: 'uploadLogo', error: 'The file is not a PNG image.' } }
    answer(JSON.stringify(failure))
    await vi.waitFor(() => expect(applyActionMock).toHaveBeenCalledWith(failure))
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })

  it('uploads an image dropped onto the logo area', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const zone = page.getByTestId('company-logo-drop').element()
    const dt = files(png())
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
    zone.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    zone.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.png')
    expect(uploadedFile(fn).name).toBe('logo.png')
  })

  it('uploads an image pasted while the page is focused', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const paste = new ClipboardEvent('paste', { clipboardData: files(png()), bubbles: true, cancelable: true })
    document.body.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(true)
    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.png')
    expect(uploadedFile(fn).name).toBe('logo.png')
  })

  it('leaves pasting text into the name field alone', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const dt = new DataTransfer()
    dt.setData('text/plain', 'Kindred Digital Labs')
    const paste = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    page.getByTestId('company-name-input').element().dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(false)
    expect(fn).not.toHaveBeenCalled()
  })

  it('refuses a file of the wrong type before uploading and keeps the reason visible', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46])], 'anim.gif', { type: 'image/gif' })
    page.getByTestId('company-logo-drop').element().dispatchEvent(
      new DragEvent('drop', { dataTransfer: files(gif), bubbles: true, cancelable: true }),
    )
    await expect
      .element(page.getByTestId('company-logo').getByRole('alert'))
      .toHaveTextContent('A logo must be a PNG, JPEG, SVG or WebP image (got image/gif).')
    expect(fn).not.toHaveBeenCalled()
  })

  it('says so when the upload cannot reach the server', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const input = page.getByTestId('company-logo-file').element() as HTMLInputElement
    input.files = files(png()).files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await expect
      .element(page.getByTestId('company-logo').getByRole('alert'))
      .toHaveTextContent('The logo did not reach the server')
    expect(applyActionMock).not.toHaveBeenCalled()
  })

  it('tells Mac users how to let Chrome open folders again, and that drop and paste need no access', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    await expect
      .element(page.getByTestId('company-logo-mac-hint'))
      .toHaveTextContent('System Settings → Privacy & Security → Files and Folders → Google Chrome')
  })
})
