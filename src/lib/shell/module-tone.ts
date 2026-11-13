/**
 * Presentation only: the colour each part wears, taken from the website's
 * "What's inside" bento (../eigenEnterprise-website). Keyed by module id like
 * the shell's icon map; any other module is grey. The classes live in
 * src/routes/layout.css (`.tile-*`, `.ico-*`).
 */
export type Tone =
  | 'black'
  | 'yellow'
  | 'ice'
  | 'blue'
  | 'green'
  | 'grey'
  | 'paper'
  | 'violet'
  | 'peach'

const TONES: Record<string, Tone> = {
  website: 'blue',
  email: 'ice',
  messages: 'black',
  calls: 'green',
  calendar: 'green',
  memory: 'violet',
  drive: 'grey',
  brand: 'yellow',
  members: 'peach',
  contacts: 'peach',
  repos: 'paper',
  contribute: 'yellow',
  settings: 'grey',
}

export function toneOf(id: string): Tone {
  return TONES[id] ?? 'grey'
}

/** Gradient tiles carry the website's grain. */
export function hasGrain(tone: Tone): boolean {
  return tone === 'violet' || tone === 'peach'
}
