import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { MAX_LOGO_BYTES } from '$lib/company/identity'
import { checkLogo, cropLogo, CROPPED_LOGO_PX, MAX_LOGO_PX, MIN_LOGO_PX, resolveCompanyLogoDir } from './logo'

const raster = (format: 'png' | 'jpeg' | 'webp', width = 64, height = 32) =>
  sharp({ create: { width, height, channels: 3, background: '#336699' } })
    .toFormat(format)
    .toBuffer()
    .then((b) => new Uint8Array(b))

const text = (s: string) => new TextEncoder().encode(s)
const decode = (b: Uint8Array) => new TextDecoder().decode(b)

const SVG =
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 40 20" width="40" height="20"><defs><path id="p" d="M0 0h10v10z"/></defs><style>.a{fill:#c00}</style><rect class="a" width="40" height="20"/><use xlink:href="#p"/></svg>'

describe('checkLogo — raster', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('accepts a %s and keeps its bytes as they are', async (format) => {
    const bytes = await raster(format)
    const check = await checkLogo(bytes, `image/${format}`)
    expect(check).toMatchObject({ ok: true, mime: `image/${format}`, width: 64, height: 32 })
    if (check.ok) expect(check.bytes).toEqual(bytes)
  })

  it('ignores parameters on the declared type', async () => {
    expect(await checkLogo(await raster('png'), 'image/png; charset=binary')).toMatchObject({ ok: true })
  })

  it('refuses other types (415), naming what is accepted', async () => {
    const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#000' } }).gif().toBuffer()
    expect(await checkLogo(new Uint8Array(gif), 'image/gif')).toEqual({
      ok: false,
      status: 415,
      error: 'A logo must be a PNG, JPEG, SVG or WebP image (got image/gif).',
    })
    expect(await checkLogo(await raster('png'), null)).toMatchObject({ ok: false, status: 415 })
  })

  it('refuses bytes that are not the declared type', async () => {
    expect(await checkLogo(await raster('jpeg'), 'image/png')).toEqual({
      ok: false,
      status: 400,
      error: 'The file is not a PNG image.',
    })
    expect(await checkLogo(text('hello'), 'image/webp')).toEqual({ ok: false, status: 400, error: 'The file is not a WebP image.' })
  })

  it('refuses an empty file and one over the size limit (413)', async () => {
    expect(await checkLogo(new Uint8Array(), 'image/png')).toEqual({ ok: false, status: 400, error: 'The file is empty.' })
    const big = new Uint8Array(MAX_LOGO_BYTES + 1)
    expect(await checkLogo(big, 'image/png')).toMatchObject({ ok: false, status: 413 })
  })

  it('refuses a logo too small to show or too large to be one', async () => {
    expect(await checkLogo(await raster('png', MIN_LOGO_PX - 1, 40), 'image/png')).toMatchObject({ ok: false, status: 400 })
    expect(await checkLogo(await raster('png', MAX_LOGO_PX + 1, 40), 'image/png')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('checkLogo — SVG', () => {
  it('accepts a plain SVG and stores it sanitized (gradients, styles and <use> kept)', async () => {
    const check = await checkLogo(text(SVG), 'image/svg+xml')
    expect(check).toMatchObject({ ok: true, mime: 'image/svg+xml', width: 40, height: 20 })
    if (!check.ok) return
    const out = decode(check.bytes)
    expect(out.startsWith('<svg')).toBe(true)
    expect(out).toContain('<style>.a{fill:#c00}</style>')
    expect(out).toContain('xlink:href="#p"')
    expect((await sharp(Buffer.from(check.bytes)).metadata()).format).toBe('svg')
  })

  it.each([
    ['a <script> element', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>'],
    ['an event handler', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><rect width="10" height="10"/></svg>'],
    ['a handler on a child', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect onclick="x()" width="10" height="10"/></svg>'],
  ])('refuses an SVG with %s', async (_, svg) => {
    expect(await checkLogo(text(svg), 'image/svg+xml')).toEqual({
      ok: false,
      status: 400,
      error: 'This SVG contains scripts. Export it as a plain SVG (or a PNG) and upload that.',
    })
  })

  it('drops links that would run code and editor metadata, keeping the drawing', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" viewBox="0 0 10 10" inkscape:version="1.0"><a xlink:href="javascript:alert(1)"><path d="M0 0h10v10z"/></a></svg>'
    const check = await checkLogo(text(svg), 'image/svg+xml')
    expect(check.ok).toBe(true)
    if (!check.ok) return
    const out = decode(check.bytes)
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('inkscape')
    expect(out).toContain('<path d="M0 0h10v10z"')
  })

  it('gives a root without its namespace one, so it renders as an image', async () => {
    const check = await checkLogo(text('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'), 'image/svg+xml')
    expect(check.ok && decode(check.bytes)).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  it('refuses markup that is not an SVG image', async () => {
    expect(await checkLogo(text('<html><body>hi</body></html>'), 'image/svg+xml')).toEqual({
      ok: false,
      status: 400,
      error: 'The file is not an SVG image.',
    })
    expect(await checkLogo(await raster('png'), 'image/svg+xml')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('cropLogo', () => {
  /** 400×200: red on the left half, blue on the right. */
  const halves = () =>
    sharp({ create: { width: 400, height: 200, channels: 3, background: '#ff0000' } })
      .composite([{ input: { create: { width: 200, height: 200, channels: 3, background: '#0000ff' } }, left: 200, top: 0 }])
      .png()
      .toBuffer()
      .then((b) => new Uint8Array(b))

  async function pixel(bytes: Uint8Array, x: number, y: number) {
    const { data, info } = await sharp(Buffer.from(bytes)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const at = (y * info.width + x) * 4
    return [...data.subarray(at, at + 4)]
  }

  it('cuts the square out as a PNG, transparent where it reaches past the image', async () => {
    const cut = await cropLogo(await halves(), { left: 0, top: -100, size: 400 })
    expect(cut).toMatchObject({ ok: true, mime: 'image/png', width: 400, height: 400 })
    if (!cut.ok) return
    expect((await sharp(Buffer.from(cut.bytes)).metadata()).format).toBe('png')
    expect(await pixel(cut.bytes, 200, 20)).toEqual([0, 0, 0, 0])
    expect(await pixel(cut.bytes, 100, 200)).toEqual([255, 0, 0, 255])
    expect(await pixel(cut.bytes, 300, 200)).toEqual([0, 0, 255, 255])
  })

  it('a zoomed-in crop shows only that part of the image', async () => {
    const cut = await cropLogo(await halves(), { left: 250, top: 50, size: 100 })
    expect(cut).toMatchObject({ ok: true, width: 100, height: 100 })
    if (cut.ok) expect(await pixel(cut.bytes, 50, 50)).toEqual([0, 0, 255, 255])
  })

  it(`is at most ${CROPPED_LOGO_PX} pixels wide`, async () => {
    const big = new Uint8Array(await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#336699' } }).jpeg().toBuffer())
    expect(await cropLogo(big, { left: 0, top: 0, size: 1000 })).toMatchObject({ ok: true, width: CROPPED_LOGO_PX, height: CROPPED_LOGO_PX })
  })

  it('crops the image the way it is shown: turned upright by its EXIF orientation', async () => {
    // Stored 40×20, shown 20×40 (orientation 6: turn 90° clockwise).
    const turned = new Uint8Array(await sharp({ create: { width: 40, height: 20, channels: 3, background: '#336699' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer())
    expect(await cropLogo(turned, { left: 0, top: 20, size: 20 })).toMatchObject({ ok: true, width: 20, height: 20 })
    expect(await cropLogo(turned, { left: 20, top: 0, size: 20 })).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a crop it cannot use, saying why', async () => {
    expect(await cropLogo(await halves(), { left: 0, top: 0, size: 4 })).toEqual({
      ok: false,
      status: 400,
      error: 'The crop is too small (at least 16 pixels of the image).',
    })
    expect(await cropLogo(await halves(), 'nonsense')).toMatchObject({ ok: false, status: 400 })
  })
})

describe('resolveCompanyLogoDir', () => {
  it("lives in its own namespace next to the Drive's files", () => {
    expect(resolveCompanyLogoDir({ DRIVE_STORAGE_DIR: '/srv/drive' })).toBe('/srv/drive/company')
    expect(resolveCompanyLogoDir({ EE_STATE_DIR: '/var/lib/ee' })).toBe('/var/lib/ee/drive/company')
  })

  it('refuses to guess a location', () => {
    expect(() => resolveCompanyLogoDir({})).toThrow(/Drive storage is not configured/)
  })
})
