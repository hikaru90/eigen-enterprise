import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Accessibility contract of the shared UI primitives (Contribute b73604ff,
 * round 3 W6). The tokens themselves are covered by
 * src/routes/layout.contrast.spec.ts; this pins what the primitives do with
 * them: no text under the 13px floor, solid focus rings that stay visible in
 * forced-colors mode, and colours that come from tokens instead of opacity.
 */

const uiDir = path.dirname(fileURLToPath(import.meta.url))

function sources(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    if (!/\.(svelte|ts)$/.test(entry.name) || /\.spec\.ts$/.test(entry.name)) return []
    return [{ file: path.relative(uiDir, full), text: readFileSync(full, 'utf-8') }]
  })
}

const all = sources(uiDir)

function offenders(pattern: RegExp): string[] {
  return all.flatMap(({ file, text }) =>
    text
      .split('\n')
      .flatMap((line, i) => [...line.matchAll(pattern)].map((m) => `${file}:${i + 1} ${m[0]}`)),
  )
}

describe('ui primitives: accessibility contract', () => {
  it('reads every primitive', () => {
    expect(all.length).toBeGreaterThan(80)
  })

  it('never sets text below the 13px floor', () => {
    const tooSmall = all.flatMap(({ file, text }) =>
      [...text.matchAll(/text-\[([\d.]+)(px|rem)\]/g)]
        .filter((m) => Number(m[1]) * (m[2] === 'rem' ? 16 : 1) < 13)
        .map((m) => `${file} ${m[0]}`),
    )
    expect(tooSmall).toEqual([])
    expect(offenders(/\btext-(2xs|xxs)\b/g)).toEqual([])
  })

  it('draws focus rings in the solid ring colour, never a faded one', () => {
    expect(offenders(/focus-visible:(ring|border|outline)-(ring|destructive)\/\d+/g)).toEqual([])
  })

  it('keeps a focus outline in forced-colors mode (outline-hidden, not outline-none)', () => {
    expect(offenders(/\boutline-none\b/g)).toEqual([])
  })

  it('tints destructive fills no stronger than the /20 the contrast pairs check', () => {
    const tints = all.flatMap(({ file, text }) =>
      [...text.matchAll(/bg-destructive\/(\d+)/g)]
        .filter((m) => Number(m[1]) > 20)
        .map((m) => `${file} ${m[0]}`),
    )
    expect(tints).toEqual([])
  })

  it('takes text colour from tokens, not from opacity', () => {
    expect(
      offenders(/\btext-(foreground|muted-foreground|card-foreground|popover-foreground)\/\d+/g),
    ).toEqual([])
  })

  it('gives every interactive primitive a visible focus ring', () => {
    for (const file of [
      'button/button-variants.ts',
      'badge/badge.svelte',
      'input/input.svelte',
      'textarea/textarea.svelte',
      'checkbox/checkbox.svelte',
      'switch/switch.svelte',
      'radio-group/radio-group-item.svelte',
      'select/select-trigger.svelte',
      'tabs/tabs-trigger.svelte',
    ]) {
      const text = all.find((s) => s.file === file)?.text
      expect(text, file).toBeDefined()
      expect(text, file).toMatch(/focus-visible:ring-(1|2)\b/)
      expect(text, file).toMatch(/focus-visible:ring-ring\b/)
    }
  })

  it('types form fields at 16px on phones (no iOS zoom) and 14px from md up', () => {
    for (const file of ['input/input.svelte', 'textarea/textarea.svelte']) {
      const text = all.find((s) => s.file === file)?.text ?? ''
      expect(text, file).toMatch(/(?<![:\w-])text-base\b/)
      expect(text, file).toMatch(/(?<![\w-])md:text-sm\b/)
      expect(text, file).not.toMatch(/(?<![:\w-])text-xs\b/)
      expect(text, file).not.toMatch(/(?<![\w-])md:text-xs\b/)
    }
  })
})
