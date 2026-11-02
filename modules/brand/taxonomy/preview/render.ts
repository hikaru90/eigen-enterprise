import type { PickerNode, PickerTokenSet } from '../picker-index'
import type { PreviewCopy } from './copy'

/** Fixed preview canvas (CSS px); rendered at 2× DPR → 640×440 images. */
export const PREVIEW_WIDTH = 320
export const PREVIEW_HEIGHT = 220

export type PreviewMode = 'light' | 'dark'
type Shape = PickerNode['shape']

const RADIUS: Record<Shape['radius'], string> = {
  none: '0px',
  xs: '2px',
  sm: '4px',
  md: '7px',
  lg: '10px',
  xl: '14px',
  pill: '999px',
}
const BORDER: Record<Shape['border'], string> = { none: '0px', hairline: '1px', bold: '2.5px' }
const DENSITY: Record<Shape['density'], number> = { compact: 0.75, regular: 1, airy: 1.35 }

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  )

/** CSS values must not break out of the declaration block. */
const cssVal = (s: string) => s.replace(/[;{}<>]/g, '')

/** Read a role from a token set, tolerating `--role` keys. */
function role(set: PickerTokenSet, name: string): string | undefined {
  return set[name] ?? set[`--${name}`]
}

const fontStack = (family: string, kind: 'serif' | 'sans' | 'mono') =>
  `'${cssVal(family).replace(/'/g, '')}', ${kind === 'mono' ? 'ui-monospace, monospace' : kind === 'serif' ? 'Georgia, serif' : 'system-ui, sans-serif'}`

/** Google Fonts css2 URL for the node's three families (deduplicated, sorted → deterministic). */
export function googleFontsUrl(fonts: PickerNode['fonts']): string {
  const families = [...new Set([fonts.heading, fonts.body, fonts.mono])].sort()
  const q = families
    .map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600;700`)
    .join('&')
  return `https://fonts.googleapis.com/css2?${q}&display=block`
}

function shadow(shape: Shape): string {
  if (shape.elevation === 'flat') return 'none'
  if (shape.elevation === 'subtle') return '0 1px 2px rgba(0,0,0,.08), 0 3px 8px rgba(0,0,0,.07)'
  return shape.border === 'bold'
    ? '3px 3px 0 var(--fg)'
    : '0 4px 10px rgba(0,0,0,.16), 0 12px 24px rgba(0,0,0,.14)'
}

/** All CSS custom properties the composition consumes, derived from tokens + shape + fonts. */
export function previewVars(node: PickerNode, mode: PreviewMode): Record<string, string> {
  const t = node.tokens[mode]
  const fg = role(t, 'foreground')!
  const s = node.shape
  const v: Record<string, string> = {
    '--bg': role(t, 'background')!,
    '--fg': fg,
    '--card': role(t, 'card')!,
    '--card-fg': role(t, 'card-foreground') ?? fg,
    '--primary': role(t, 'primary')!,
    '--primary-fg': role(t, 'primary-foreground')!,
    '--secondary': role(t, 'secondary')!,
    '--secondary-fg': role(t, 'secondary-foreground') ?? fg,
    '--accent': role(t, 'accent')!,
    '--accent-fg': role(t, 'accent-foreground') ?? fg,
    '--muted': role(t, 'muted')!,
    '--muted-fg': role(t, 'muted-foreground') ?? fg,
    '--border': s.border === 'none' ? 'transparent' : role(t, 'border')!,
    '--input': role(t, 'input')!,
    '--ring': role(t, 'ring')!,
    '--bpc': s.border === 'bold' ? 'var(--fg)' : 'transparent',
    '--bw': BORDER[s.border],
    '--sh': shadow(s),
    '--d': String(DENSITY[s.density]),
    '--r': RADIUS[s.radius],
    '--rp': s.radius === 'none' ? '0px' : '999px',
    '--fh': fontStack(node.fonts.heading, 'serif'),
    '--fb': fontStack(node.fonts.body, 'sans'),
    '--fm': fontStack(node.fonts.mono, 'mono'),
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cssVal(x)]))
}

const CSS = `*{box-sizing:border-box}html,body{margin:0;padding:0;width:${PREVIEW_WIDTH}px;height:${PREVIEW_HEIGHT}px;overflow:hidden}
.site{width:${PREVIEW_WIDTH}px;height:${PREVIEW_HEIGHT}px;background:var(--bg);color:var(--fg);font-family:var(--fb);font-size:9px;line-height:1.35;display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased}
nav{display:flex;align-items:center;gap:10px;padding:calc(7px*var(--d)) calc(12px*var(--d));border-bottom:var(--bw) solid var(--border)}
.logo{font-family:var(--fh);font-weight:700;font-size:11.5px;margin-right:auto;white-space:nowrap}
nav .l{opacity:.75;white-space:nowrap}
.b{font:inherit;font-weight:600;border-radius:var(--r);padding:calc(4px*var(--d)) calc(9px*var(--d));border:var(--bw) solid var(--border);box-shadow:var(--sh);white-space:nowrap}
.bp{background:var(--primary);color:var(--primary-fg);border-color:var(--bpc)}
.bs{background:var(--secondary);color:var(--secondary-fg)}
main{display:flex;gap:12px;padding:calc(12px*var(--d));flex:1;align-items:center}
.hero{flex:1.3;min-width:0}
h1{font-family:var(--fh);font-size:20px;line-height:1.06;margin:0 0 calc(6px*var(--d));font-weight:700;overflow-wrap:break-word}
.sub{margin:0 0 calc(10px*var(--d));color:var(--muted-fg)}
.row{display:flex;gap:6px}
.cd{flex:1;min-width:0;background:var(--card);color:var(--card-fg);border:var(--bw) solid var(--border);border-radius:min(var(--r),16px);box-shadow:var(--sh);padding:calc(9px*var(--d))}
.bdg{display:inline-block;background:var(--accent);color:var(--accent-fg);border-radius:var(--rp);padding:1px 6px;font-size:7.5px;font-weight:700;margin-bottom:5px}
.ct{font-family:var(--fh);font-weight:700;font-size:10.5px;margin-bottom:6px}
.inp{background:var(--bg);border:max(1px,var(--bw)) solid var(--input);border-radius:var(--r);padding:4px 6px;color:var(--muted-fg);margin-bottom:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:var(--fm);font-size:8px}
.bar{height:5px;border-radius:var(--rp);background:var(--muted);overflow:hidden}.bar i{display:block;height:100%;width:62%;background:var(--primary)}`

/**
 * The fixed preview composition (a 320×220 mini website) for one node in one
 * mode, as a standalone HTML document. Pure: same input → same string.
 */
export function renderPreviewHtml(node: PickerNode, mode: PreviewMode, copy: PreviewCopy): string {
  const vars = Object.entries(previewVars(node, mode))
    .map(([k, v]) => `${k}:${v}`)
    .join(';')
  const e = esc
  return `<!doctype html>
<html lang="en" data-mode="${mode}"><head><meta charset="utf-8">
<meta name="viewport" content="width=${PREVIEW_WIDTH}">
<title>${e(node.name)} (${mode})</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${e(googleFontsUrl(node.fonts))}">
<style>:root{${vars};color-scheme:${mode}}
${CSS}</style></head>
<body><div class="site"><nav><span class="logo">${e(copy.logo)}</span>${copy.links.map((l) => `<span class="l">${e(l)}</span>`).join('')}<span class="b bp">${e(copy.primary)}</span></nav>
<main><div class="hero"><h1>${e(copy.heading)}</h1><p class="sub">${e(copy.subtitle)}</p><div class="row"><span class="b bp">${e(copy.primary)}</span><span class="b bs">${e(copy.secondary)}</span></div></div>
<div class="cd"><span class="bdg">${e(copy.badge)}</span><div class="ct">${e(copy.cardTitle)}</div><div class="inp">${e(copy.input)}</div><div class="bar"><i></i></div></div></main></div></body></html>
`
}
