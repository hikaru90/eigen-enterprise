import { describe, expect, it } from 'vitest'
import { exportMaterial, materialFileName, type MaterialRenderer } from './export'
import { formatById, type MaterialFormat } from './formats'

const cssVars = {
  '--background': '#ffffff',
  '--foreground': '#111111',
  '--primary': '#b00000',
  '--primary-foreground': '#ffffff',
  '--accent': '#006600',
  '--muted-foreground': '#555555',
  '--font-display': '"Fraunces", serif',
}
const active = { id: 's1', name: 'Blueprint', cssVars, darkCssVars: null }
const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])

function setup(opts: { style?: typeof active | null; logo?: boolean } = {}) {
  const rendered: Array<{ html: string; format: MaterialFormat; fonts: string[] }> = []
  const render: MaterialRenderer = async (html, format, fonts) => {
    rendered.push({ html, format, fonts })
    return { bytes: new Uint8Array([1, 2, 3]), mime: format.unit === 'px' || format.kind === 'merch' ? 'image/png' : 'application/pdf' }
  }
  const deps = {
    visualSets: { findActiveVisualSet: async () => (opts.style === undefined ? active : opts.style) },
    logo: async () => (opts.logo === false ? null : { mime: 'image/png', bytes: logoBytes }),
    render,
  }
  return { deps, rendered }
}

describe('exportMaterial', () => {
  it('renders the piece in the active style with the company logo and names the file after the headline', async () => {
    const { deps, rendered } = setup()
    const out = await exportMaterial(deps, { formatId: 'poster-a1', headline: 'Hall 3, booth 12', body: 'Come by.', cta: 'Find us' })
    expect(out).toEqual({
      formatId: 'poster-a1',
      filename: 'hall-3-booth-12-poster-a1.pdf',
      mime: 'application/pdf',
      sizeBytes: 3,
      logo: true,
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(rendered).toHaveLength(1)
    expect(rendered[0].format).toEqual(formatById('poster-a1'))
    expect(rendered[0].fonts).toEqual(['Fraunces'])
    expect(rendered[0].html).toContain('data:image/png;base64,')
    expect(rendered[0].html).toContain('Hall 3, booth 12')
    expect(rendered[0].html).toContain('data-system-theme="light"')
  })

  it('logo: false leaves the logo off; no logo in Settings is no logo, said in the result', async () => {
    const off = setup()
    expect(await exportMaterial(off.deps, { formatId: 'flyer-a5', headline: 'Hi', logo: false })).toMatchObject({ logo: false })
    expect(off.rendered[0].html).not.toContain('<img')
    const none = setup({ logo: false })
    expect(await exportMaterial(none.deps, { formatId: 'flyer-a5', headline: 'Hi' })).toMatchObject({ logo: false })
  })

  it('the social header and merch are PNGs', async () => {
    const { deps } = setup()
    await expect(exportMaterial(deps, { formatId: 'banner-social', headline: 'Hi', mode: 'dark' })).resolves.toMatchObject({
      filename: 'hi-banner-social.png',
      mime: 'image/png',
    })
    await expect(exportMaterial(deps, { formatId: 'merch-tote', headline: 'Plain' })).resolves.toMatchObject({ filename: 'plain-merch-tote.png' })
  })

  it('merch takes a slogan only', async () => {
    const { deps, rendered } = setup()
    await expect(exportMaterial(deps, { formatId: 'merch-mug', headline: 'Plain', body: 'More' })).rejects.toMatchObject({ code: 'invalid' })
    expect(rendered).toHaveLength(0)
  })

  it('no active style is not_found (choose one first); bad input fails the schema', async () => {
    const { deps } = setup({ style: null })
    await expect(exportMaterial(deps, { formatId: 'flyer-a5', headline: 'Hi' })).rejects.toMatchObject({
      code: 'not_found',
      message: 'No style is active yet: choose one under Brand first.',
    })
    const ok = setup()
    await expect(exportMaterial(ok.deps, { formatId: 'nope', headline: 'Hi' })).rejects.toThrow()
    await expect(exportMaterial(ok.deps, { formatId: 'flyer-a5', headline: '' })).rejects.toThrow()
  })
})

describe('materialFileName', () => {
  it('keeps letters and digits of any script, dashes between', () => {
    expect(materialFileName('Größer & näher!', formatById('flyer-a5'), 'pdf')).toBe('größer-näher-flyer-a5.pdf')
    expect(materialFileName('!!!', formatById('flyer-a5'), 'pdf')).toBe('flyer-a5.pdf')
  })
})
