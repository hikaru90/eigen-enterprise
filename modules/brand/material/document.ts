import type { MaterialFormat } from './formats'
import { SYSTEM_SCOPE_ATTR, googleFontLinks, systemScopeCss } from '../system/component-set'
import { MaterialError, type MaterialCopy } from './types'

/**
 * One piece of brand material as a self-contained, print-ready HTML page at
 * the format's true size (millimetres for paper and merch, pixels for the
 * social header). The headless browser turns it into the PDF or PNG
 * (render.ts). It draws the same composition as the Material tab's previews,
 * from the active visual set's tokens through the same scope emitter
 * (systemScopeCss, AA-corrected) — sized in units of the format's shorter
 * side, so an A5 flyer and an A1 poster keep their proportions.
 *
 * The copy is the person's (or the AI's) text and is always escaped; the
 * company logo is embedded as a data URL, so the page loads nothing but the
 * style's web fonts.
 */

/** The colour tokens every piece is drawn with: a style without one fails loud (no silent stand-in colour). */
export const REQUIRED_MATERIAL_TOKENS = [
  '--background',
  '--foreground',
  '--primary',
  '--primary-foreground',
  '--accent',
  '--muted-foreground',
] as const

export type MaterialStyle = {
  name: string
  cssVars: Record<string, string>
  darkCssVars: Record<string, string> | null
}

export type MaterialLogo = { mime: string; bytes: Uint8Array }

export type MaterialDocumentInput = {
  format: MaterialFormat
  mode: 'light' | 'dark'
  copy: MaterialCopy
  style: MaterialStyle
  logo: MaterialLogo | null
}

type Layout = 'flyer' | 'landscape' | 'rollup' | 'poster' | 'merch'

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c])

function layoutOf(format: MaterialFormat): Layout {
  if (format.kind === 'merch') return 'merch'
  if (format.width > format.height) return 'landscape'
  if (format.kind === 'poster') return 'poster'
  if (format.kind === 'banner') return 'rollup'
  return 'flyer'
}

function checkTokens(style: MaterialStyle, mode: 'light' | 'dark'): void {
  const tokens = mode === 'dark' ? { ...style.cssVars, ...(style.darkCssVars ?? {}) } : style.cssVars
  for (const token of REQUIRED_MATERIAL_TOKENS) {
    if (!tokens[token]?.trim()) {
      throw new MaterialError('invalid', `The active style has no ${token} token, which brand material is drawn with.`)
    }
  }
}

function mark(style: MaterialStyle, logo: MaterialLogo | null, inverted = false): string {
  if (logo) {
    return `<img class="logo" src="data:${logo.mime};base64,${Buffer.from(logo.bytes).toString('base64')}" alt="">`
  }
  return `<span class="mark${inverted ? ' inverted' : ''}"><span class="dot"></span><span class="mark-name">${esc(style.name)}</span></span>`
}

const cta = (copy: MaterialCopy) => (copy.cta ? `<span class="cta">${esc(copy.cta)}</span>` : '')
const body = (copy: MaterialCopy) => (copy.body ? `<p class="body">${esc(copy.body)}</p>` : '')
const headline = (copy: MaterialCopy) => `<h1 class="headline">${esc(copy.headline)}</h1>`
const bar = '<div class="bar"></div>'

function content(layout: Layout, copy: MaterialCopy, style: MaterialStyle, logo: MaterialLogo | null): string {
  switch (layout) {
    case 'flyer':
      return `<header>${mark(style, logo)}</header><main>${headline(copy)}${body(copy)}</main><footer>${cta(copy)}${bar}</footer>`
    case 'landscape':
      return `<main>${mark(style, logo)}${headline(copy)}${body(copy)}</main><aside>${cta(copy)}<div class="bar short"></div></aside>`
    case 'rollup':
      return `<header>${mark(style, logo)}</header><main>${headline(copy)}${body(copy)}${cta(copy)}</main><footer><div class="block"></div>${bar}</footer>`
    case 'poster':
      return `<section class="top">${logo ? '' : mark(style, null, true)}${headline(copy)}</section><section class="bottom">${body(copy)}<div class="row">${cta(copy)}${mark(style, logo)}</div>${bar}</section>`
    case 'merch':
      return logo
        ? `${mark(style, logo)}<div class="slogan">${headline(copy)}<div class="bar short"></div></div>`
        : `<span class="emblem"></span><div class="slogan">${headline(copy)}<div class="bar short"></div>${mark(style, null)}</div>`
  }
}

/** Layout CSS in `u` = 1% of the format's shorter side. */
function css(format: MaterialFormat, layout: Layout): string {
  const w = `${format.width}${format.unit}`
  const h = `${format.height}${format.unit}`
  const u = `${Math.min(format.width, format.height) / 100}${format.unit}`
  return `
@page { size: ${w} ${h}; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${w}; height: ${h}; overflow: hidden; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { --u: ${u}; width: ${w}; height: ${h}; display: flex; overflow: hidden; background: var(--background); color: var(--foreground); font-family: var(--font-sans, sans-serif); }
.headline { font-family: var(--font-display, var(--font-sans, serif)); font-weight: 600; line-height: 1.1; overflow-wrap: anywhere; }
.body { color: var(--muted-foreground); line-height: 1.4; overflow-wrap: anywhere; }
.cta { display: inline-block; width: fit-content; background: var(--primary); color: var(--primary-foreground); font-weight: 500; border-radius: calc(var(--u) * 1); }
.bar { height: calc(var(--u) * 1.2); width: 100%; border-radius: 999px; background: var(--accent); }
.bar.short { width: calc(var(--u) * 14); }
.mark { display: flex; align-items: center; gap: calc(var(--u) * 1.6); }
.dot { width: calc(var(--u) * 2.4); height: calc(var(--u) * 2.4); border-radius: 50%; background: var(--primary); flex-shrink: 0; }
.mark-name { font-size: calc(var(--u) * 2.2); font-weight: 500; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted-foreground); }
.mark.inverted .dot { background: var(--primary-foreground); }
.mark.inverted .mark-name { color: var(--primary-foreground); }
.logo { display: block; height: calc(var(--u) * 7); max-width: calc(var(--u) * 40); object-fit: contain; }
${LAYOUT_CSS[layout]}`
}

const LAYOUT_CSS: Record<Layout, string> = {
  flyer: `
.sheet { flex-direction: column; justify-content: space-between; padding: calc(var(--u) * 7); }
main { display: flex; flex-direction: column; gap: calc(var(--u) * 3.5); }
footer { display: flex; flex-direction: column; gap: calc(var(--u) * 3); }
.headline { font-size: calc(var(--u) * 9); }
.body { font-size: calc(var(--u) * 3.6); }
.cta { font-size: calc(var(--u) * 3); padding: calc(var(--u) * 1.8) calc(var(--u) * 3.6); }`,
  landscape: `
.sheet { align-items: center; justify-content: space-between; gap: calc(var(--u) * 8); padding: calc(var(--u) * 10); }
main { display: flex; flex-direction: column; gap: calc(var(--u) * 3); min-width: 0; }
aside { display: flex; flex-direction: column; align-items: flex-end; gap: calc(var(--u) * 4); flex-shrink: 0; }
.headline { font-size: calc(var(--u) * 11); }
.body { font-size: calc(var(--u) * 5); }
.cta { font-size: calc(var(--u) * 5); padding: calc(var(--u) * 3) calc(var(--u) * 6); }
.logo { height: calc(var(--u) * 12); max-width: calc(var(--u) * 60); }
.mark-name { font-size: calc(var(--u) * 4); }
.dot { width: calc(var(--u) * 4); height: calc(var(--u) * 4); }`,
  rollup: `
.sheet { flex-direction: column; justify-content: space-between; padding: calc(var(--u) * 8); }
main { display: flex; flex-direction: column; gap: calc(var(--u) * 5); }
footer { display: flex; flex-direction: column; gap: calc(var(--u) * 3); }
.headline { font-size: calc(var(--u) * 12); }
.body { font-size: calc(var(--u) * 4.5); }
.cta { font-size: calc(var(--u) * 4); padding: calc(var(--u) * 2.2) calc(var(--u) * 4.4); }
.block { height: calc(var(--u) * 30); border-radius: calc(var(--u) * 1.5); background: var(--primary); }
.logo { height: calc(var(--u) * 12); max-width: calc(var(--u) * 70); }`,
  poster: `
.sheet { flex-direction: column; }
.top { flex: 1; display: flex; flex-direction: column; justify-content: space-between; gap: calc(var(--u) * 5); padding: calc(var(--u) * 8); background: var(--primary); color: var(--primary-foreground); }
.bottom { display: flex; flex-direction: column; gap: calc(var(--u) * 4); padding: calc(var(--u) * 8); }
.row { display: flex; align-items: center; justify-content: space-between; gap: calc(var(--u) * 4); }
.headline { font-size: calc(var(--u) * 13); line-height: 1; }
.body { font-size: calc(var(--u) * 3.6); }
.cta { font-size: calc(var(--u) * 3.2); padding: calc(var(--u) * 1.8) calc(var(--u) * 3.6); }`,
  merch: `
.sheet { align-items: center; justify-content: center; gap: calc(var(--u) * 6); padding: calc(var(--u) * 8); text-align: center; }
.sheet[data-orientation="portrait"] { flex-direction: column; }
.slogan { display: flex; flex-direction: column; align-items: center; gap: calc(var(--u) * 4); min-width: 0; }
.emblem { width: calc(var(--u) * 14); height: calc(var(--u) * 14); border-radius: 50%; background: var(--primary); flex-shrink: 0; }
.headline { font-size: calc(var(--u) * 10); }
.logo { height: calc(var(--u) * 22); max-width: calc(var(--u) * 70); }`,
}

/** The style's web fonts a piece is set in: display (headlines) and sans (everything else); mono is never used. */
export function materialFontLinks(cssVars: Record<string, string>): { family: string; href: string }[] {
  const roles: Record<string, string> = {}
  for (const role of ['--font-display', '--font-sans'] as const) if (cssVars[role]) roles[role] = cssVars[role]
  return googleFontLinks(roles)
}

export function materialDocument(input: MaterialDocumentInput): string {
  const { format, mode, copy, style, logo } = input
  checkTokens(style, mode)
  const layout = layoutOf(format)
  const fonts = materialFontLinks(style.cssVars)
    .map((f) => `<link rel="stylesheet" href="${f.href}">`)
    .join('\n')
  const orientation = format.width > format.height ? 'landscape' : 'portrait'
  return `<!doctype html>
<html lang="en" ${SYSTEM_SCOPE_ATTR}="${mode}"${mode === 'dark' ? ' class="dark"' : ''}>
<head>
<meta charset="utf-8">
${fonts}
<style>
${systemScopeCss(style.cssVars, style.darkCssVars)}
${css(format, layout)}
</style>
</head>
<body>
<article class="sheet" data-format="${format.id}" data-layout="${layout}" data-orientation="${orientation}">${content(layout, copy, style, logo)}</article>
</body>
</html>
`
}
