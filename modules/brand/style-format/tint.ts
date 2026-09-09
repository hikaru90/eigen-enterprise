import { converter, parse } from 'culori'

/**
 * Project any brand color onto the OKLCH lightness axis as a #rrggbb gray.
 *
 * The water-flow shader's monochrome invariant is an Eigen brand constant
 * (parseMonochromeTint rejects chromatic tints), but a tenant brand may well
 * be chromatic. Chromatic brands therefore project onto the L axis — chroma
 * is dropped, lightness is kept — so the flow stays live and
 * brand-luminance-influenced instead of tripping the static fallback.
 *
 * Already-gray hex passes through byte-identical; everything else goes
 * oklch -> (l, c=0) -> clamped sRGB -> #rrggbb, which parseMonochromeTint
 * accepts by construction (r=g=b). Pure and deterministic: identical input,
 * identical output. Fail loud on non-colors.
 */

const HEX_TINT = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

function expandHex(hex: string): string {
  return hex.length === 3
    ? (hex[0] ?? '') + (hex[0] ?? '') + (hex[1] ?? '') + (hex[1] ?? '') + (hex[2] ?? '') + (hex[2] ?? '')
    : hex
}

export function grayscaleTint(input: string): string {
  const value = input.trim()
  const hex = HEX_TINT.exec(value)
  if (hex) {
    const full = expandHex(hex[1] ?? '')
    const r = full.slice(0, 2)
    const g = full.slice(2, 4)
    const b = full.slice(4, 6)
    if (r === g && g === b) return value
  }

  const parsed = parse(value)
  if (!parsed) {
    throw new Error(`grayscaleTint("${input}") is not a color (hex or CSS color string); no silent fallback`)
  }
  const oklch = converter('oklch')(parsed)
  if (!oklch || oklch.l === undefined) {
    throw new Error(`grayscaleTint("${input}") does not resolve to OKLCH lightness; no silent fallback`)
  }
  // c=0 keeps only the L axis; h is irrelevant at zero chroma. The OKLab gray
  // axis maps to identical r/g/b linear values, so the emitted hex is exactly
  // monochrome after 8-bit rounding.
  const rgb = converter('rgb')({ mode: 'oklch', l: clamp01(oklch.l), c: 0, h: 0 })
  if (!rgb || rgb.r === undefined || rgb.g === undefined || rgb.b === undefined) {
    throw new Error(`grayscaleTint("${input}") failed to resolve to sRGB; no silent fallback`)
  }
  const toByte = (channel: number) => Math.round(clamp01(channel) * 255)
  const gray = toByte(rgb.r)
  const byte = gray.toString(16).padStart(2, '0')
  return `#${byte}${byte}${byte}`
}
