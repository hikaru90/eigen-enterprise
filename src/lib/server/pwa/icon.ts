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
