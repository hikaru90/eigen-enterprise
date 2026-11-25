import { describe, expect, it } from 'vitest'
import { materialDocument, REQUIRED_MATERIAL_TOKENS } from './document'
import { formatById } from './formats'

const cssVars = {
  '--background': '#ffffff',
  '--foreground': '#111111',
  '--primary': '#b00000',
  '--primary-foreground': '#ffffff',
  '--accent': '#006600',
  '--muted-foreground': '#555555',
  '--font-display': '"Fraunces", serif',
  '--font-sans': 'Inter, sans-serif',
  '--font-mono': '"JetBrains Mono", monospace',
}
const style = { name: 'Blueprint', cssVars, darkCssVars: { '--background': '#000000' } }
const copy = { headline: 'Hall 3, booth 12', body: 'Come by.', cta: 'Find us' }
const png = { mime: 'image/png' as const, bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }

const doc = (over: Partial<Parameters<typeof materialDocument>[0]> = {}) =>
  materialDocument({ format: formatById('flyer-a5'), mode: 'light', copy, style, logo: null, ...over })

describe('materialDocument', () => {
  it('a print format is one page at its exact size in millimetres, nothing outside it', () => {
    const html = doc({ format: formatById('poster-a1') })
    expect(html).toContain('@page { size: 594mm 841mm; margin: 0; }')
    expect(html).toMatch(/\.sheet \{[^}]*width: 594mm; height: 841mm;/)
    expect(html).toContain('data-format="poster-a1"')
  })

  it('a screen format is sized in pixels', () => {
    const html = doc({ format: formatById('banner-social') })
    expect(html).toMatch(/\.sheet \{[^}]*width: 1500px; height: 500px;/)
    expect(html).toContain('data-layout="landscape"')
  })

  it('draws from the active style: its tokens in the chosen theme scope, its fonts linked', () => {
    const html = doc({ mode: 'dark' })
    expect(html).toContain('<html lang="en" data-system-theme="dark" class="dark">')
    expect(html).toContain('--primary: #b00000')
    expect(html).toContain('--background: #000000')
    expect(html).toContain('https://fonts.googleapis.com/css2?family=Fraunces&display=swap')
    expect(html).toContain('https://fonts.googleapis.com/css2?family=Inter&display=swap')
    // Material never sets code: the mono face is not fetched.
    expect(html).not.toContain('family=JetBrains')
  })

  it('escapes the copy (it is the person’s or the AI’s text, never markup)', () => {
    const html = doc({ copy: { headline: '<script>x()</script> & "co"', body: 'a<b', cta: 'go' } })
    expect(html).toContain('&lt;script&gt;x()&lt;/script&gt; &amp; &quot;co&quot;')
    expect(html).not.toContain('<script>x()')
    expect(html).toContain('a&lt;b')
  })

  it('places the company logo as an embedded image in place of the style mark', () => {
    const html = doc({ logo: png })
    expect(html).toContain('<img class="logo" src="data:image/png;base64,iVBORw==" alt="">')
    expect(html).not.toContain('class="mark-name"')
  })

  it('without a logo the piece carries the style mark (the primary dot and the style name)', () => {
    const html = doc()
    expect(html).toContain('<span class="mark-name">Blueprint</span>')
    expect(html).not.toContain('<img')
  })

  it('merch carries the slogan only — no body, no button', () => {
    const html = doc({ format: formatById('merch-shirt'), copy: { headline: 'Make it plain' } })
    expect(html).toContain('Make it plain')
    expect(html).not.toContain('class="body"')
    expect(html).not.toContain('class="cta"')
  })

  it('every kind lays out its own shape', () => {
    expect(doc({ format: formatById('banner-rollup') })).toContain('data-layout="rollup"')
    expect(doc({ format: formatById('poster-a2') })).toContain('data-layout="poster"')
    expect(doc({ format: formatById('merch-mug') })).toContain('data-layout="merch"')
    expect(doc()).toContain('data-layout="flyer"')
  })

  it('fails loud when the active style lacks a colour the material is drawn with', () => {
    const { ['--accent']: _gone, ...without } = cssVars
    expect(() => doc({ style: { ...style, cssVars: without } })).toThrow(
      'The active style has no --accent token, which brand material is drawn with.',
    )
    expect(REQUIRED_MATERIAL_TOKENS).toContain('--accent')
  })
})
