import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import AvatarPicker from './avatar-picker.svelte'

const SHA = 'a'.repeat(64)

async function makePngFile(name = 'photo.png'): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 32
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#FF4632'
  ctx.fillRect(0, 0, 64, 32)
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
  return new File([blob], name, { type: 'image/png' })
}

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ sha256: SHA, image: `/api/people/avatar/${SHA}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})

afterEach(() => {
  fetchSpy.mockRestore()
})

const inputValue = (testid: string) => (page.getByTestId(testid).element() as HTMLInputElement).value

describe('avatar-picker.svelte', () => {
  it('renders all 8 CI presets, updates hidden inputs on selection, and supports clearing back to initials', async () => {
    render(AvatarPicker, { idPrefix: 'test-cw', name: 'Mara' })
    for (const id of ['prism', 'orbit', 'blocks', 'arch', 'signal', 'mosaic', 'beacon', 'ribbon']) {
      await expect.element(page.getByTestId(`test-cw-avatar-preset-${id}`)).toBeVisible()
    }
    expect(inputValue('test-cw-avatar-preset-input')).toBe('')
    expect(inputValue('test-cw-avatar-sha-input')).toBe('')

    await page.getByTestId('test-cw-avatar-preset-prism').click()
    await expect.element(page.getByTestId('test-cw-avatar-preset-prism')).toHaveAttribute('aria-pressed', 'true')
    expect(inputValue('test-cw-avatar-preset-input')).toBe('prism')
    expect(inputValue('test-cw-avatar-sha-input')).toBe('')
    await expect.element(page.getByTestId('test-cw-avatar-preview')).toHaveAttribute('data-has-image', 'true')
    expect(page.getByTestId('test-cw-avatar-preview').element().querySelector('img')?.getAttribute('src')).toBe(
      '/avatars/coworkers/prism.svg',
    )

    await page.getByTestId('test-cw-avatar-clear').click()
    expect(inputValue('test-cw-avatar-preset-input')).toBe('')
    expect(inputValue('test-cw-avatar-sha-input')).toBe('')
    await expect.element(page.getByTestId('test-cw-avatar-preview')).toHaveAttribute('data-has-image', 'false')
  })

  it('crops/encodes an uploaded image to 256x256 WebP, posts to /api/people/avatar/upload, and previews locally', async () => {
    render(AvatarPicker, { idPrefix: 'test-cw', name: 'Mara', avatarPreset: 'prism' })
    const file = await makePngFile()
    await userEvent.upload(page.getByTestId('test-cw-avatar-file'), file)

    await expect.poll(() => fetchSpy.mock.calls.length).toBe(1)
    const [url, init] = fetchSpy.mock.calls[0]!
    expect(url).toBe('/api/people/avatar/upload')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe('image/webp')
    expect((init?.body as Blob).type).toBe('image/webp')

    await expect.poll(() => inputValue('test-cw-avatar-sha-input')).toBe(SHA)
    expect(inputValue('test-cw-avatar-preset-input')).toBe('')
    const previewSrc = page.getByTestId('test-cw-avatar-preview').element().querySelector('img')?.getAttribute('src')
    expect(previewSrc).toMatch(/^blob:/)
  })

  it('shows an accessible error when a non-image file is picked or the upload fails', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Only admins can upload.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    )
    render(AvatarPicker, { idPrefix: 'test-cw', name: 'Mara' })
    const file = await makePngFile('bad.png')
    await userEvent.upload(page.getByTestId('test-cw-avatar-file'), file)
    await expect.element(page.getByTestId('test-cw-avatar-error')).toHaveTextContent('Only admins can upload.')
    expect(inputValue('test-cw-avatar-sha-input')).toBe('')

    const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const input = page.getByTestId('test-cw-avatar-file').element() as HTMLInputElement
    const dt = new DataTransfer()
    dt.items.add(textFile)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await expect.element(page.getByTestId('test-cw-avatar-error')).toHaveTextContent(/not an image/i)
  })
})
