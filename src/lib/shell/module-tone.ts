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

/**
 * A part's mark: the colour of its icon square (2026-11-16). The website
 * gives every part a colour (../eigenEnterprise-website, "What's inside");
 * the app keeps the stages neutral and lets the colour show only on the
 * small mark — on module cards and next to an area's title. The classes
 * live in src/routes/layout.css (`.mark-*`).
 */
export type Mark = 'blue' | 'ice' | 'green' | 'violet' | 'peach' | 'yellow' | 'grey' | 'ink' | 'white'

const MARKS: Record<string, Mark> = {
  website: 'blue',
  email: 'ice',
  messages: 'ink',
  calls: 'green',
  calendar: 'green',
  memory: 'violet',
  drive: 'grey',
  brand: 'yellow',
  members: 'peach',
  contacts: 'peach',
  assistant: 'yellow',
}

/** The part's mark; a part without a colour is neutral: ink on a light stage, white on a dark one. */
export function markOf(id: string, onDark = false): Mark {
  return MARKS[id] ?? (onDark ? 'white' : 'ink')
}
