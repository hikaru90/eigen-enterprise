import { describe, expect, it } from 'vitest'
import { auditSource, type FadedTextRule } from './page-style-audit'

/** Light tokens close to the app's: #111 text, #666 secondary on white / pale grey surfaces. */
const LIGHT: Record<string, string> = {
  '--background': '#e8ede5',
  '--card': '#ffffff',
  '--popover': '#ffffff',
  '--muted': '#f0f3f0',
  '--foreground': '#111111',
  '--muted-foreground': '#666666',
  '--primary': '#111111',
  '--primary-foreground': '#ffffff',
  '--ring': '#666666',
}
const rule: FadedTextRule = { contexts: { light: LIGHT } }
const audit = (source: string) => auditSource(source, rule)
const kinds = (source: string) => audit(source).map((f) => `${f.kind}:${f.match}`)

describe('tiny text', () => {
  it('flags arbitrary sizes below 13px, in px and rem', () => {
    expect(kinds('<p class="text-[10px] text-[0.7rem] text-[12px]">x</p>')).toEqual([
      'tiny-text:text-[10px]',
      'tiny-text:text-[0.7rem]',
      'tiny-text:text-[12px]',
    ])
  })

  it('accepts the 13px floor and above, and the theme steps', () => {
    expect(
      kinds('<p class="text-[13px] text-[0.8125rem] text-[15px] text-xs text-sm">x</p>'),
    ).toEqual([])
  })

  it('flags variant-prefixed sizes and sizes in script class strings', () => {
    expect(kinds("<script>const c = 'sm:text-[11px]'</script>")).toEqual([
      'tiny-text:sm:text-[11px]',
    ])
  })

  it('flags small font-size declarations in <style>, but not em (relative to the text around it)', () => {
    expect(
      kinds(
        '<style>.a { font-size: 0.75rem; } .b { font-size: 11px } .c { font-size: 0.85em; } .d { font-size: 1rem; }</style>',
      ),
    ).toEqual(['tiny-text:font-size: 0.75rem', 'tiny-text:font-size: 11px'])
  })
})

describe('faded text', () => {
  it('flags a token text colour whose opacity drops it below 4.5:1 on any surface', () => {
    // #111 at 55% on #e8ede5 is ~3.98:1; at 60% ~4.67:1.
    expect(kinds('<p class="text-foreground/55 text-foreground/60">x</p>')).toEqual([
      'faded-text:text-foreground/55',
    ])
  })

  it('flags any reduced muted-foreground: the token sits close to the minimum already', () => {
    expect(
      kinds('<p class="text-muted-foreground/80 hover:text-muted-foreground/70">x</p>'),
    ).toEqual(['faded-text:text-muted-foreground/80', 'faded-text:hover:text-muted-foreground/70'])
  })

  it('measures on-colour tokens on their own fill', () => {
    // #fff at 70% on #111 is well above 4.5:1.
    expect(kinds('<span class="text-primary-foreground/70">x</span>')).toEqual([])
  })

  it('exempts disabled states (SC 1.4.3 does not apply to inactive controls)', () => {
    expect(kinds('<button class="disabled:text-foreground/40">x</button>')).toEqual([])
  })

  it('ignores non-text utilities that share the prefix', () => {
    expect(
      kinds('<p class="bg-foreground/10 border-foreground/20 ring-foreground/10">x</p>'),
    ).toEqual([])
  })

  it('fails loud on a token the contexts do not declare', () => {
    expect(() => audit('<p class="text-sidebar-foreground/50">x</p>')).toThrow(
      /--sidebar-foreground/,
    )
  })
})

describe('faded focus indicator', () => {
  it('flags a focus ring in the ring colour faded below 3:1 (SC 1.4.11)', () => {
    expect(kinds('<a class="focus-visible:ring-2 focus-visible:ring-ring/60">x</a>')).toEqual([
      'faded-focus:focus-visible:ring-ring/60',
    ])
    expect(kinds('<div class="focus-within:border-ring/50">x</div>')).toEqual([
      'faded-focus:focus-within:border-ring/50',
    ])
  })

  it('accepts the full ring colour and a ring alpha that still reaches 3:1', () => {
    expect(
      kinds(
        '<a class="focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-ring/95">x</a>',
      ),
    ).toEqual([])
  })

  it('ignores ring colours outside a focus state', () => {
    expect(kinds('<div class="ring-1 ring-ring/20">x</div>')).toEqual([])
  })
})

describe('outline-none without a focus replacement', () => {
  it('flags an element that removes the outline and shows nothing else on focus', () => {
    expect(kinds('<input class="bg-transparent outline-none" />')).toEqual([
      'no-focus-style:outline-none',
    ])
    expect(kinds('<div tabindex="0" class="outline-hidden">x</div>')).toEqual([
      'no-focus-style:outline-hidden',
    ])
  })

  it('accepts a focus-visible / focus replacement on the same element', () => {
    expect(
      kinds('<input class="outline-none focus-visible:ring-2 focus-visible:ring-ring" />'),
    ).toEqual([])
    expect(kinds('<a href="/" class="outline-none focus:border-ring">x</a>')).toEqual([])
    expect(
      kinds('<div role="option" class="outline-hidden data-highlighted:bg-accent">x</div>'),
    ).toEqual([])
  })

  it('accepts a programmatic focus target (tabindex -1): not in the tab order', () => {
    expect(kinds('<h2 tabindex="-1" class="outline-none">x</h2>')).toEqual([])
    expect(kinds('<p tabindex={-1} class="outline-none">x</p>')).toEqual([])
  })

  it('accepts a field whose wrapper shows the focus (focus-within)', () => {
    const source = `<div class="rounded border focus-within:ring-2 focus-within:ring-ring">
  <span>label</span>
  <textarea class="outline-none" onkeydown={(e) => e.key === 'Enter' && send()}></textarea>
</div>`
    expect(kinds(source)).toEqual([])
  })

  it('does not credit a closed sibling with focus-within', () => {
    const source = `<div class="focus-within:ring-2"><input class="x" /></div>
<input class="outline-none" />`
    expect(kinds(source)).toEqual(['no-focus-style:outline-none'])
  })

  it('reads attributes that contain arrow functions and braces', () => {
    const source = `<Button onclick={() => (open = !open)} class={cn('outline-none', open && 'x')}>go</Button>`
    expect(kinds(source)).toEqual(['no-focus-style:outline-none'])
  })

  it('reads a class string built in script on its own: it must carry the focus style', () => {
    expect(kinds("<script>const a = 'outline-none focus-visible:ring-2'</script>")).toEqual([])
    expect(kinds("<script>const a = `x outline-none ${on ? 'y' : 'z'}` // it's</script>")).toEqual([
      'no-focus-style:outline-none',
    ])
    expect(
      auditSource(
        `export const v = "[&_svg:not([class*='size-'])]:size-4 outline-hidden focus-visible:ring-1"`,
        rule,
        {
          markup: false,
        },
      ),
    ).toEqual([])
  })

  it('reports the 1-based line of each finding', () => {
    expect(audit('<p>a</p>\n<p class="text-[9px]">b</p>')[0].line).toBe(2)
  })
})
