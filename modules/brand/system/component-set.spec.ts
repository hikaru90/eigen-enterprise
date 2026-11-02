import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUTTON_VARIANTS,
  COLOR_ROLES,
  COMPONENT_SET,
  TYPE_SCALE,
  googleFontLinks,
  primaryFamily,
  systemScopeCss,
  withFontFallback,
} from './component-set'
import { REQUIRED_VISUAL_ROLES } from '../store'

const UI_DIR = path.resolve(__dirname, '../../../src/lib/components/ui')

describe('component set (B4 §3.4)', () => {
  it('names every component the plan requires, exactly once', () => {
    const ids = COMPONENT_SET.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [
      'button',
      'input',
      'textarea',
      'select',
      'checkbox-switch',
      'card',
      'badge',
      'alert',
      'tabs',
      'table',
      'dialog',
      'nav',
      'typography',
      'colors',
      'radius',
      'shadow',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('uses only the app’s existing shadcn components (no parallel ones)', () => {
    for (const entry of COMPONENT_SET) {
      for (const ui of entry.uses) {
        expect(existsSync(path.join(UI_DIR, ui, 'index.ts')), `${entry.id} → ui/${ui}`).toBe(true)
      }
    }
  })

  it('buttons cover primary, secondary, outline, ghost, destructive, sizes and disabled', () => {
    const button = COMPONENT_SET.find((c) => c.id === 'button')!
    expect([...BUTTON_VARIANTS]).toEqual([
      'default',
      'secondary',
      'outline',
      'ghost',
      'destructive',
    ])
    expect(button.variants).toEqual(
      expect.arrayContaining(['size:sm', 'size:default', 'size:lg', 'disabled']),
    )
  })

  it('the typography scale runs display → mono with the right font roles', () => {
    expect(TYPE_SCALE.map((s) => s.id)).toEqual([
      'display',
      'h1',
      'h2',
      'h3',
      'h4',
      'body',
      'small',
      'mono',
    ])
    expect(TYPE_SCALE.find((s) => s.id === 'h1')!.font).toBe('display')
    expect(TYPE_SCALE.find((s) => s.id === 'mono')!.font).toBe('mono')
  })

  it('every colour role swatch is a role the active set resolves (or a shadcn pair)', () => {
    const required = new Set<string>(REQUIRED_VISUAL_ROLES)
    for (const { role } of COLOR_ROLES) {
      if (role === 'destructive') continue // app default; sets may override
      expect(required.has(role), role).toBe(true)
    }
  })
})

describe('fonts', () => {
  it('reads the brand family, ignoring generics', () => {
    expect(primaryFamily('"Newsreader"')).toBe('Newsreader')
    expect(primaryFamily("'IBM Plex Mono', monospace")).toBe('IBM Plex Mono')
    expect(primaryFamily('ui-sans-serif, system-ui')).toBeNull()
  })

  it('appends class-correct fallbacks, keeps stacks that already end in a generic', () => {
    expect(withFontFallback('--font-display', '"Newsreader"')).toBe(
      '"Newsreader", ui-serif, Georgia, serif',
    )
    expect(withFontFallback('--font-display', '"Space Grotesk"')).toBe(
      '"Space Grotesk", ui-serif, Georgia, serif',
    )
    expect(withFontFallback('--font-sans', '"Inter"')).toBe(
      '"Inter", ui-sans-serif, system-ui, sans-serif',
    )
    expect(withFontFallback('--font-mono', '"Unlisted Mono"')).toBe(
      '"Unlisted Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    )
    expect(withFontFallback('--font-sans', 'Inter, sans-serif')).toBe('Inter, sans-serif')
  })

  it('builds one Google Fonts link per distinct family (display, sans, mono)', () => {
    expect(
      googleFontLinks({
        '--font-display': '"Playfair Display"',
        '--font-sans': '"Playfair Display"',
        '--font-mono': '"IBM Plex Mono", monospace',
        '--primary': 'red',
      }),
    ).toEqual([
      {
        family: 'Playfair Display',
        href: 'https://fonts.googleapis.com/css2?family=Playfair+Display&display=swap',
      },
      {
        family: 'IBM Plex Mono',
        href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap',
      },
    ])
    expect(googleFontLinks({ '--font-sans': 'system-ui, sans-serif' })).toEqual([])
  })
})

describe('systemScopeCss', () => {
  it('emits a light and a dark scope; dark overlays dark tokens on the light set', () => {
    const css = systemScopeCss(
      { '--primary': '#ff0000', '--background': '#ffffff', '--font-sans': '"Inter"' },
      { '--background': '#000000' },
    )
    // Doubled attribute: beats the app's own `.dark` token block on the scope element.
    expect(css).toContain("[data-system-theme][data-system-theme='light'] {")
    expect(css).toContain("[data-system-theme][data-system-theme='dark'] {")
    const [light, dark] = css.split("[data-system-theme='dark']")
    expect(light).toContain('--background: #ffffff;')
    expect(light).toContain('color-scheme: light;')
    expect(light).toContain('--font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;')
    expect(dark).toContain('--background: #000000;')
    expect(dark).toContain('--primary: #ff0000;')
    expect(dark).toContain('color-scheme: dark;')
  })

  it('is deterministic and shows light tokens in both scopes without dark tokens', () => {
    const vars = { '--b': '1', '--a': '2' }
    expect(systemScopeCss(vars, null)).toBe(systemScopeCss({ '--a': '2', '--b': '1' }, null))
    expect(systemScopeCss(vars, null).split('--a: 2;').length).toBe(3)
  })
})
