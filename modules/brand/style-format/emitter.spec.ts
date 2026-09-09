import { describe, expect, it } from 'vitest'
import { toCssText } from './emitter'

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
