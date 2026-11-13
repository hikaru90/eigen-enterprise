/**
 * Presentation only: the stage each part sits on, from the owner's reference
 * board (2026-11-13): white, stone, charcoal and ink grounds; coral is kept
 * for what needs attention, never for a part. Keyed by module id like the
 * shell's icon map; any other module is white. The classes live in
 * src/routes/layout.css (`.stage-*`).
 */
export type Tone = 'ink' | 'charcoal' | 'stone' | 'white'

const TONES: Record<string, Tone> = {
  website: 'ink',
  memory: 'ink',
  messages: 'charcoal',
  calls: 'charcoal',
  email: 'stone',
  brand: 'stone',
}

export function toneOf(id: string): Tone {
  return TONES[id] ?? 'white'
}

/** Dark stages take a white icon squircle; light ones a black one. */
export function isDark(tone: Tone): boolean {
  return tone === 'ink' || tone === 'charcoal'
}
