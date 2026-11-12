import { describe, expect, it } from 'vitest'
import { auditContrast } from './contrast'
import { activeVisualSetCss, activeVisualSetStyleTag, brandShellVars, toCssText } from './emitter'

describe('toCssText', () => {
  it('emits a sorted, deterministic css custom-property block', () => {
    const vars = { '--z': '1', '--background': 'oklch(0.985 0.01 152)', '--a-b': '2px' }
    const css = toCssText(vars, ':root')
    expect(css).toBe(
      [
        ':root {',
        '  --a-b: 2px;',
        '  --background: oklch(0.985 0.01 152);',
        '  --z: 1;',
        '}',
        '',
      ].join('\n'),
    )
  })

  it('is stable across repeated calls', () => {
    const vars = { '--b': '1', '--a': '2' }
    expect(toCssText(vars, '.x')).toBe(toCssText({ ...vars, '--a': '2', '--b': '1' }, '.x'))
  })

  it('round-trips any selector', () => {
    expect(toCssText({ '--x': '0' }, '.scope-y.dark')).toContain('.scope-y.dark {')
  })
})

describe('activeVisualSetCss (phase-2d M5 global :root override)', () => {
  const light = { '--background': '#e8ede5', '--foreground': '#111111' }
  const dark = { '--background': '#0b0f0c', '--foreground': '#eeeeee' }

  it('emits a :root block, sorted and deterministic', () => {
    const css = activeVisualSetCss({ ...light }, null)
    expect(css).toBe(
      [':root {', '  --background: #e8ede5;', '  --foreground: #111111;', '}', ''].join('\n'),
    )
    expect(activeVisualSetCss(light, null)).toBe(activeVisualSetCss({ ...light }, null))
  })

  it('appends a .dark block when dark tokens exist', () => {
    const css = activeVisualSetCss(light, dark)
    expect(css).toContain(':root {')
    expect(css).toContain('.dark {')
    expect(css.indexOf(':root {')).toBeLessThan(css.indexOf('.dark {'))
    expect(css).toContain('  --background: #0b0f0c;')
  })

  it('omits the .dark block for null and for empty dark token sets', () => {
    expect(activeVisualSetCss(light, null)).not.toContain('.dark')
    expect(activeVisualSetCss(light, {})).not.toContain('.dark')
  })
})

describe('activeVisualSetStyleTag (phase-2d M5 head injection)', () => {
  it('wraps the override in exactly one style element', () => {
    const tag = activeVisualSetStyleTag(
      { '--background': '#e8ede5' },
      { '--background': '#0b0f0c' },
    )
    expect(tag.startsWith('<style>')).toBe(true)
    expect(tag.endsWith('</style>')).toBe(true)
    expect(tag.match(/<style>/g)).toHaveLength(1)
    expect(tag).toContain(':root {')
    expect(tag).toContain('.dark {')
  })
})

describe('brandShellVars (C3 brand-wide shell aliases)', () => {
  const set = {
    '--background': '#faf6ee',
    '--foreground': '#1c1917',
    '--primary': '#5b2a6e',
    '--font-sans': '"Source Serif 4"',
    '--font-display': '"Playfair Display", serif',
  }

  it('derives the sidebar, heading font and overlay from the set roles', () => {
    const vars = brandShellVars(set)
    expect(vars['--sidebar']).toContain('var(--primary)')
    expect(vars['--sidebar-primary']).toBe('var(--primary)')
    expect(vars['--sidebar-foreground']).toBe('var(--foreground)')
    expect(vars['--font-heading']).toBe('var(--font-display)')
    expect(vars['--overlay']).toContain('var(--primary)')
  })

  it("paints the browser and installed app's status bar in the set's background", () => {
    // The root layout copies --theme-color into <meta name="theme-color">.
    expect(brandShellVars(set)['--theme-color']).toBe('var(--background)')
  })

  it('never overrides a key the set declares itself', () => {
    expect(brandShellVars({ ...set, '--sidebar': '#000' })['--sidebar']).toBe('#000')
    expect(brandShellVars({ ...set, '--shadow-1': '0 1px 2px red' })['--shadow-1']).toBe(
      '0 1px 2px red',
    )
  })

  it('flattens shadows for a set without elevation tokens', () => {
    const vars = brandShellVars(set)
    expect([vars['--shadow-1'], vars['--shadow-2'], vars['--shadow-3']]).toEqual([
      'none',
      'none',
      'none',
    ])
    expect(brandShellVars({ ...set, '--shadow-1': 'x' })['--shadow-2']).toBeUndefined()
  })
})

describe('activeVisualSetCss holds a brand set to WCAG 2.1 AA (Contribute b73604ff)', () => {
  const lowContrast = {
    '--background': '#ffffff',
    '--foreground': '#111111',
    '--card': '#ffffff',
    '--card-foreground': '#111111',
    '--popover': '#ffffff',
    '--popover-foreground': '#111111',
    '--primary': '#2563eb',
    '--primary-foreground': '#ffffff',
    '--secondary': '#f4f4f5',
    '--secondary-foreground': '#111111',
    '--muted': '#f4f4f5',
    '--muted-foreground': '#a1a1aa',
    '--accent': '#f4f4f5',
    '--accent-foreground': '#111111',
    '--destructive': '#ef4444',
    '--border': '#e4e4e7',
    '--input': '#e4e4e7',
    '--ring': '#a1a1aa',
    '--radius': '0.5rem',
  }
  // Dark tokens without --input / --ring: the light values carry into dark mode.
  const darkTokens = {
    '--background': '#09090b',
    '--foreground': '#fafafa',
    '--card': '#18181b',
    '--card-foreground': '#fafafa',
    '--popover': '#18181b',
    '--popover-foreground': '#fafafa',
    '--primary': '#3b82f6',
    '--primary-foreground': '#ffffff',
    '--secondary': '#27272a',
    '--secondary-foreground': '#fafafa',
    '--muted': '#27272a',
    '--muted-foreground': '#52525b',
    '--accent': '#27272a',
    '--accent-foreground': '#fafafa',
    '--destructive': '#7f1d1d',
    '--border': '#27272a',
  }

  function parseBlock(cssText: string, selector: string): Record<string, string> {
    const start = cssText.indexOf(`${selector} {`)
    if (start < 0) return {}
    const body = cssText.slice(cssText.indexOf('{', start) + 1, cssText.indexOf('}', start))
    return Object.fromEntries([...body.matchAll(/(--[\w-]+): ([^;]+);/g)].map((m) => [m[1], m[2]]))
  }

  it('emits tokens that pass every pair, in light and in dark', () => {
    const cssText = activeVisualSetCss(lowContrast, darkTokens)
    const light = parseBlock(cssText, ':root')
    const dark = { ...light, ...parseBlock(cssText, '.dark') }
    for (const [mode, tokens] of [
      ['light', light],
      ['dark', dark],
    ] as const) {
      for (const result of auditContrast(tokens)) {
        expect(result.ratio, `${mode}: ${result.pair.id}`).toBeGreaterThanOrEqual(result.pair.min)
      }
    }
  })

  it('keeps the brand: surfaces and passing tokens are emitted byte-identical', () => {
    const light = parseBlock(activeVisualSetCss(lowContrast, null), ':root')
    for (const key of [
      '--background',
      '--card',
      '--muted',
      '--primary',
      '--foreground',
      '--primary-foreground',
      '--radius',
    ] as const) {
      expect(light[key], key).toBe(lowContrast[key])
    }
    expect(light['--muted-foreground']).not.toBe(lowContrast['--muted-foreground'])
  })

  it('corrects a light-only role that fails in dark inside the .dark block', () => {
    // A dark input border passes on the light background but vanishes on the dark one.
    const cssText = activeVisualSetCss({ ...lowContrast, '--input': '#3f3f46' }, darkTokens)
    expect(parseBlock(cssText, ':root')['--input']).toBe('#3f3f46')
    const darkInput = parseBlock(cssText, '.dark')['--input']
    expect(darkInput).toBeDefined()
    expect(darkInput).not.toBe('#3f3f46')
  })

  it('leaves a set that already passes untouched', () => {
    const fine = {
      ...lowContrast,
      '--muted-foreground': '#52525b',
      '--destructive': '#b91c1c',
      '--input': '#71717a',
      '--ring': '#52525b',
    }
    expect(parseBlock(activeVisualSetCss(fine, null), ':root')).toEqual(fine)
  })
})
