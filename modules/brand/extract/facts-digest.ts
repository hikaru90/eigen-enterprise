/**
 * Pure facts -> compact text digest for the extraction prompt (phase-2d M2).
 * Nothing here decides meaning (G14): counts, sets and frequencies only.
 */

export type ElementFacts = {
  color: string
  backgroundColor: string
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  letterSpacing: string
  borderRadius: string
  boxShadow: string
  borderWidth: string
  borderStyle: string
  padding: string
  margin: string
}

export type SiteFacts = {
  selectors: Record<string, ElementFacts[]>
  themeColor: string | null
  title: string
  colorCensus: Array<{ color: string; count: number }>
}

const CENSUS_LIMIT = 15

/** Normalizes computed colors so rgb/hex/oklch forms tally together. */
export function normalizeColor(color: string): string {
  const trimmed = color.trim()
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (rgb) {
    const [, r, g, b, a] = rgb
    if (a === undefined || Number(a) === 1) {
      const hex = [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
      return `#${hex}`
    }
    return `rgba(${Number(r)}, ${Number(g)}, ${Number(b)}, ${Number(a)})`
  }
  const oklch = trimmed.match(/^oklch\(([^)]+)\)$/)
  if (oklch) {
    return `oklch(${oklch[1].replace(/\s+/g, ' ').trim()})`
  }
  return trimmed
}

function tally(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function formatTally(pairs: Array<[string, number]>): string {
  return pairs.map(([value, count]) => `${value} (${count})`).join(', ')
}

export function digestFacts(facts: SiteFacts): string {
  const lines: string[] = []
  lines.push(`SITE: ${facts.title}`)
  lines.push(`THEME-COLOR: ${facts.themeColor ?? 'unknown'}`)

  const census = facts.colorCensus
    .slice()
    .sort((a, b) => b.count - a.count || a.color.localeCompare(b.color))
    .slice(0, CENSUS_LIMIT)
    .map((c) => `${c.color} (${c.count})`)
  lines.push(`COLORS (distinct, by frequency): ${census.join(', ')}`)

  for (const selector of Object.keys(facts.selectors).sort()) {
    const elements = facts.selectors[selector]
    if (elements.length === 0) continue
    const families = formatTally(tally(elements.map((e) => e.fontFamily)).slice(0, 3))
    const sizes = formatTally(tally(elements.map((e) => e.fontSize)).slice(0, 5))
    const weights = formatTally(tally(elements.map((e) => e.fontWeight)).slice(0, 5))
    lines.push(`TYPE ${selector}: fonts ${families} | sizes ${sizes} | weights ${weights}`)
  }

  const all = Object.values(facts.selectors).flat()
  if (all.length > 0) {
    lines.push(`RADII: ${formatTally(tally(all.map((e) => normalizeColor(e.borderRadius))))}`)
    lines.push(`PADDING: ${formatTally(tally(all.map((e) => e.padding)).slice(0, 8))}`)
    lines.push(`MARGIN: ${formatTally(tally(all.map((e) => e.margin)).slice(0, 8))}`)
    lines.push(`SHADOWS: ${formatTally(tally(all.map((e) => e.boxShadow)).slice(0, 5))}`)
    lines.push(
      `BORDERS: ${formatTally(
        tally(all.map((e) => `${e.borderWidth} ${e.borderStyle}`)).slice(0, 5),
      )}`,
    )
  }

  return lines.join('\n')
}
