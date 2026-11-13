/**
 * Presentation only: the tile each part wears on the dashboard. Neutral
 * grounds from the owner's reference board (2026-11-13) — ink, charcoal,
 * stone, mist and the slate dusk gradient — so a screen of parts reads calm;
 * the coral accent is kept for what needs attention, never for a part.
 * Keyed by module id like the shell's icon map; any other module is mist.
 * The classes live in src/routes/layout.css (`.tile-*`).
 */
export type Tone = 'ink' | 'charcoal' | 'stone' | 'mist' | 'slate'

const TONES: Record<string, Tone> = {
  website: 'slate',
  messages: 'ink',
  calls: 'charcoal',
  memory: 'charcoal',
  email: 'stone',
  brand: 'stone',
  calendar: 'stone',
}

export function toneOf(id: string): Tone {
  return TONES[id] ?? 'mist'
}

/** Dark tiles take light icon circles and chips. */
export function isDark(tone: Tone): boolean {
  return tone === 'ink' || tone === 'charcoal' || tone === 'slate'
}

/** Gradient tiles carry the website's grain. */
export function hasGrain(tone: Tone): boolean {
  return tone === 'slate'
}
