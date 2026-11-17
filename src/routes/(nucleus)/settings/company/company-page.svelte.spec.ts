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

type Logo = { url: string; mime: string; original?: { url: string; crop: { left: number; top: number; size: number } } | null }
const props = (company: { name: string | null; logo: Logo | null }, form: unknown = null) =>
  ({ data: { company }, form, params: {} }) as never

/** An SVG uploads as it is (no crop step). */
const svg = () =>
  new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><rect width="20" height="10"/></svg>'], 'logo.svg', {
    type: 'image/svg+xml',
  })

/** A real 400×200 PNG the browser can show (raster logos are cropped first). */
async function png(): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = 400
  canvas.height = 200
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#336699'
  ctx.fillRect(0, 0, 400, 200)
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
  return new File([blob], 'logo.png', { type: 'image/png' })
}

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

  it('uploads an SVG as soon as it is picked, shows it is uploading, then applies the result', async () => {
    const { fn, answer } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const input = page.getByTestId('company-logo-file').element() as HTMLInputElement
    const file = svg()
    input.files = files(file).files
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.svg')
    await expect.element(page.getByTestId('company-logo-upload')).toBeDisabled()
    expect(uploadedFile(fn).name).toBe('logo.svg')

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
    input.files = files(svg()).files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    const failure = { type: 'failure', status: 400, data: { action: 'uploadLogo', error: 'The file is not an SVG image.' } }
    answer(JSON.stringify(failure))
    await vi.waitFor(() => expect(applyActionMock).toHaveBeenCalledWith(failure))
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })

  it('uploads an SVG dropped onto the logo area', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const zone = page.getByTestId('company-logo-drop').element()
    const dt = files(svg())
    const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
    zone.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    zone.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.svg')
    expect(uploadedFile(fn).name).toBe('logo.svg')
  })

  it('uploads an SVG pasted while the page is focused', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const paste = new ClipboardEvent('paste', { clipboardData: files(svg()), bubbles: true, cancelable: true })
    document.body.dispatchEvent(paste)
    expect(paste.defaultPrevented).toBe(true)
    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.svg')
    expect(uploadedFile(fn).name).toBe('logo.svg')
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
    input.files = files(svg()).files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await expect
      .element(page.getByTestId('company-logo').getByRole('alert'))
      .toHaveTextContent('The logo did not reach the server')
    expect(applyActionMock).not.toHaveBeenCalled()
  })

  it('a picked PNG opens the crop frame first; Save logo uploads it with the crop', async () => {
    const { fn, answer } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    const input = page.getByTestId('company-logo-file').element() as HTMLInputElement
    input.files = files(await png()).files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await expect.element(page.getByTestId('logo-cropper')).toBeInTheDocument()
    await expect.element(page.getByTestId('company-logo-drop')).not.toBeVisible()
    expect(fn).not.toHaveBeenCalled()

    await expect.element(page.getByTestId('logo-crop-save')).toBeEnabled()
    await page.getByTestId('logo-crop-save').click()
    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Uploading logo.png')
    expect(uploadedFile(fn).name).toBe('logo.png')
    const body = (fn.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect(JSON.parse(String(body.get('crop')))).toEqual({ left: 0, top: -100, size: 400 })

    answer(JSON.stringify({ type: 'success', status: 200, data: { action: 'uploadLogo', ok: true } }))
    await expect.element(page.getByTestId('logo-cropper')).not.toBeInTheDocument()
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
  })

  it('a refused crop keeps the frame open to try again', async () => {
    const { answer } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    page.getByTestId('company-logo-drop').element().dispatchEvent(
      new DragEvent('drop', { dataTransfer: files(await png()), bubbles: true, cancelable: true }),
    )
    await expect.element(page.getByTestId('logo-crop-save')).toBeEnabled()
    await page.getByTestId('logo-crop-save').click()
    const failure = { type: 'failure', status: 400, data: { action: 'uploadLogo', error: 'The crop is too small.' } }
    answer(JSON.stringify(failure))
    await vi.waitFor(() => expect(applyActionMock).toHaveBeenCalledWith(failure))
    await expect.element(page.getByTestId('logo-cropper')).toBeInTheDocument()
  })

  it('Cancel leaves the logo as it was, uploading nothing', async () => {
    const { fn } = pendingFetch()
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: files(await png()), bubbles: true, cancelable: true }))
    await page.getByTestId('logo-crop-cancel').click()
    await expect.element(page.getByTestId('logo-cropper')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('company-logo-drop')).toBeVisible()
    expect(fn).not.toHaveBeenCalled()
  })

  it('Adjust crop reopens the kept original where the crop left it, and saves only the new crop', async () => {
    const { fn } = pendingFetch()
    const original = URL.createObjectURL(await png())
    render(
      CompanyPage,
      props({ name: 'Kindred', logo: { url: '/api/company/logo/cut', mime: 'image/png', original: { url: original, crop: { left: 100, top: 0, size: 200 } } } }),
    )
    await page.getByTestId('company-logo-adjust').click()
    await expect.element(page.getByTestId('logo-crop-image')).toHaveAttribute('src', original)
    await expect.element(page.getByTestId('logo-crop-save')).toBeEnabled()
    await page.getByTestId('logo-crop-save').click()
    await expect.element(page.getByTestId('company-logo-status')).toHaveTextContent('Saving the new crop')
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('?/recropLogo')
    const body = init.body as FormData
    expect(body.get('logo')).toBeNull()
    const crop = JSON.parse(String(body.get('crop'))) as { left: number; top: number; size: number }
    expect(crop.left).toBeCloseTo(100)
    expect(crop.top).toBeCloseTo(0)
    expect(crop.size).toBeCloseTo(200)
    URL.revokeObjectURL(original)
  })

  it('offers Adjust crop only for a logo with a kept original', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: { url: '/api/company/logo/abc', mime: 'image/svg+xml', original: null } }))
    await expect.element(page.getByTestId('company-logo-remove')).toBeInTheDocument()
    await expect.element(page.getByTestId('company-logo-adjust')).not.toBeInTheDocument()
  })

  it('tells Mac users how to let Chrome open folders again, and that drop and paste need no access', async () => {
    render(CompanyPage, props({ name: 'Kindred', logo: null }))
    await expect
      .element(page.getByTestId('company-logo-mac-hint'))
      .toHaveTextContent('System Settings → Privacy & Security → Files and Folders → Google Chrome')
  })
})
