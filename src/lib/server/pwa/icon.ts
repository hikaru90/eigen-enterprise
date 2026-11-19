import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import opentype from 'opentype.js'
import sharp from 'sharp'
import type { IconKind, IdentityColors } from '$lib/pwa/identity'

/**
 * Renders the company's app icon (src/lib/pwa/identity.ts): its initial in
 * Inter Bold on the brand's primary color. The glyph is drawn as a vector
 * path from the bundled font (no system fonts on the server needed), then
 * rasterized by sharp.
 *
 * - any: rounded tile, transparent corners (desktop docks, favicons)
 * - maskable / apple: full-bleed square — Android and iOS shape it themselves;
 *   maskable keeps the letter well inside the 80% safe zone.
 *
 * Inter covers Latin, Greek, Cyrillic and Vietnamese; an initial from another
 * script (e.g. CJK) gets the plain brand tile.
 */

const SUBSETS = ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'vietnamese']

let fonts: opentype.Font[] | null = null
function loadFonts(): opentype.Font[] {
  if (fonts) return fonts
  const require = createRequire(import.meta.url)
  fonts = SUBSETS.map((s) => {
    const file = readFileSync(require.resolve(`@fontsource/inter/files/inter-${s}-700-normal.woff`))
    return opentype.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))
  })
  return fonts
}

function glyphFor(ch: string): { font: opentype.Font } | null {
  for (const font of loadFonts()) if (font.charToGlyphIndex(ch) > 0) return { font }
  return null
}

/** The glyph's path, centered in a size×size box at the given cap height share. */
function glyphPath(ch: string, size: number, share: number): string | null {
  const found = glyphFor(ch)
  if (!found) return null
  const probe = found.font.getPath(ch, 0, 0, 1000).getBoundingBox()
  const height = probe.y2 - probe.y1
  const width = probe.x2 - probe.x1
  // Scale so the taller of width/height fills `share` of the icon.
  const fontSize = (1000 * size * share) / Math.max(height, width)
  const path = found.font.getPath(ch, 0, 0, fontSize)
  const box = path.getBoundingBox()
  const dx = size / 2 - (box.x1 + box.x2) / 2
  const dy = size / 2 - (box.y1 + box.y2) / 2
  return found.font.getPath(ch, dx, dy, fontSize).toPathData(2)
}

export async function renderAppIcon(opts: {
  initial: string
  colors: IdentityColors
  kind: IconKind
  size: number
}): Promise<Buffer> {
  const { initial, colors, kind, size } = opts
  const share = kind === 'maskable' ? 0.38 : 0.5
  const radius = kind === 'any' ? Math.round(size * 0.225) : 0
  const path = glyphPath(initial, size, share)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${colors.tile}"/>
${path ? `<path d="${path}" fill="${colors.glyph}"/>` : ''}
</svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

/**
 * The company logo (Settings → Company) as an app icon, whole and centered
 * (contain — never cropped; an SVG is rasterized at the icon's size):
 *
 * - any: the logo itself on transparency, filling the icon (favicons, docks)
 * - maskable: on the backdrop, inside the 80% safe zone (Android masks it)
 * - apple: on the backdrop with a small margin (iOS rounds the corners)
 *
 * The backdrop is the logo's own background when its edge is one solid color
 * (a square avatar on a colored ground), so the margin continues the logo;
 * otherwise the brand background.
 */
const LOGO_SHARE: Record<IconKind, number> = { any: 1, maskable: 0.56, apple: 0.8 }

export async function renderLogoIcon(opts: {
  logo: Uint8Array
  colors: IdentityColors
  kind: IconKind
  size: number
}): Promise<Buffer> {
  const { logo, colors, kind, size } = opts
  const inner = Math.round(size * LOGO_SHARE[kind])
  // An SVG is rasterized at the density that makes it `inner` pixels (its own size may be tiny or huge).
  const meta = await sharp(Buffer.from(logo)).metadata()
  if (!meta.width || !meta.height) throw new Error(`[pwa] the company logo has no size (format ${meta.format})`)
  const density = meta.format === 'svg' ? Math.min(2400, Math.max(1, (72 * inner) / Math.max(meta.width, meta.height))) : undefined
  // `inside`, not `contain`: no transparent letterbox, so the logo's real edge can be read below.
  const art = await sharp(Buffer.from(logo), density ? { density } : {})
    .resize(inner, inner, { fit: 'inside' })
    .ensureAlpha()
    .png()
    .toBuffer()
  const background = kind === 'any' ? { r: 0, g: 0, b: 0, alpha: 0 } : ((await solidEdgeColor(art)) ?? colors.background)
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: art, gravity: 'centre' }])
    .png()
    .toBuffer()
}

/** Share of edge pixels that must be one opaque color for it to count as the logo's background. */
const SOLID_EDGE_SHARE = 0.9
/** Per-channel distance from that color still counted as it (anti-aliasing, JPEG noise). */
const EDGE_TOLERANCE = 20

/**
 * The logo's background color: the opaque color (within a small tolerance for
 * anti-aliasing and compression) that covers nearly all of its outermost
 * pixel ring — or null when the edge is transparent or mixed.
 */
async function solidEdgeColor(png: Buffer): Promise<{ r: number; g: number; b: number; alpha: number } | null> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height } = info
  const edge: number[] = []
  for (let x = 0; x < width; x++) edge.push(x, (height - 1) * width + x)
  for (let y = 1; y < height - 1; y++) edge.push(y * width, y * width + width - 1)
  const opaque = edge.filter((p) => data[p * 4 + 3] >= 250)
  if (opaque.length < edge.length * SOLID_EDGE_SHARE) return null
  // The per-channel median is the candidate; nearly every edge pixel must sit close to it.
  const median = [0, 1, 2].map((c) => {
    const values = opaque.map((p) => data[p * 4 + c]).sort((a, b) => a - b)
    return values[values.length >> 1]
  })
  const near = opaque.filter((p) => [0, 1, 2].every((c) => Math.abs(data[p * 4 + c] - median[c]) <= EDGE_TOLERANCE))
  if (near.length < edge.length * SOLID_EDGE_SHARE) return null
  const mean = (c: number) => Math.round(near.reduce((sum, p) => sum + data[p * 4 + c], 0) / near.length)
  return { r: mean(0), g: mean(1), b: mean(2), alpha: 1 }
}
