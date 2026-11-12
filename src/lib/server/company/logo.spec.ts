import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { MAX_LOGO_BYTES } from '$lib/company/identity'
import { checkLogo, MAX_LOGO_PX, MIN_LOGO_PX, resolveCompanyLogoDir } from './logo'

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

describe('resolveCompanyLogoDir', () => {
  it("lives in its own namespace next to the Drive's files", () => {
    expect(resolveCompanyLogoDir({ DRIVE_STORAGE_DIR: '/srv/drive' })).toBe('/srv/drive/company')
    expect(resolveCompanyLogoDir({ EE_STATE_DIR: '/var/lib/ee' })).toBe('/var/lib/ee/drive/company')
  })

  it('refuses to guess a location', () => {
    expect(() => resolveCompanyLogoDir({})).toThrow(/Drive storage is not configured/)
  })
})
