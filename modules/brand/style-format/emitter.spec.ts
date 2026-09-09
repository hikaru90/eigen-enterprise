import { describe, expect, it } from 'vitest'
import { activeVisualSetCss, activeVisualSetStyleTag, toCssText } from './emitter'

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
