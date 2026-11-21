/**
 * Where dictated text goes (plan/shared-memory-voice-agent-tools.md §2): in at the cursor,
 * replacing a selection, with the spacing a typist would add. The person edits it before
 * sending; nothing here sends. Spacing is plain character layout (whitespace and brackets
 * around the cursor), never a reading of what the words mean.
 */

/** A field dictation can write into. */
export type DictationTarget = HTMLInputElement | HTMLTextAreaElement

/** Characters a new word never gets a space before (it sits right after them). */
const OPENERS = new Set(['(', '[', '{', '"', '“', '‘', '¿', '¡'])
/** Characters a new word never gets a space after (they stick to the word before). */
const CLOSERS = new Set([')', ']', '}', ',', '.', ';', ':', '!', '?', '"', '”', '’', '…'])

function isSpace(ch: string): boolean {
  return ch.trim() === ''
}

/**
 * `value` with `transcript` put between `start` and `end` (the selection; equal = a cursor),
 * and where the caret goes after it. An empty transcript changes nothing.
 */
export function spliceTranscript(
  value: string,
  start: number,
  end: number,
  transcript: string,
): { value: string; caret: number } {
  if (!(start >= 0 && start <= end && end <= value.length)) {
    throw new Error(`dictation: selection ${start}–${end} is outside a ${value.length}-character field`)
  }
  const text = transcript.trim()
  if (!text) return { value, caret: start }
  const before = start > 0 ? value[start - 1]! : ''
  const after = end < value.length ? value[end]! : ''
  const lead = before && !isSpace(before) && !OPENERS.has(before) ? ' ' : ''
  const trail = after && !isSpace(after) && !CLOSERS.has(after) ? ' ' : ''
  const inserted = `${lead}${text}${trail}`
  return {
    value: value.slice(0, start) + inserted + value.slice(end),
    caret: start + lead.length + text.length,
  }
}

/**
 * Writes `transcript` into `field`: at its cursor when the person put one there
 * (`atCursor`), else after what is already typed. Fires `input` like typing does, so
 * `bind:value`, `oninput` handlers and form state all see it, then hands the field its focus
 * back with the caret after the new words.
 */
export function dictateInto(field: DictationTarget, transcript: string, atCursor: boolean): void {
  const length = field.value.length
  const start = atCursor ? (field.selectionStart ?? length) : length
  const end = atCursor ? (field.selectionEnd ?? start) : length
  const next = spliceTranscript(field.value, start, end, transcript)
  if (next.value === field.value) return
  field.value = next.value
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.focus({ preventScroll: true })
  field.setSelectionRange(next.caret, next.caret)
}

/** Input types that hold free text. `search` is left out: in this app it filters lists. */
const TEXT_TYPES = new Set(['text'])
/** Autofill tokens for codes, addresses, credentials and numbers: spoken words don't fit them. */
const NOT_SPOKEN_AUTOCOMPLETE = /^(?:one-time-code|email|username|url|impp|photo|current-password|new-password|tel(?:-.+)?|cc-.+|postal-code|bday(?:-.+)?|transaction-.+)$/
/** Keyboards for numbers, phone numbers, addresses and links (or none at all). */
const NOT_SPOKEN_INPUTMODE = new Set(['numeric', 'decimal', 'tel', 'email', 'url', 'none'])

/**
 * Whether a single-line field takes dictation, from its own attributes alone (type,
 * autocomplete token, keyboard, read-only): password, email, number, URL, phone, date/time,
 * one-time-code and search fields don't.
 */
export function inputTakesDictation(attrs: {
  type?: string | null
  autocomplete?: string | null
  inputmode?: string | null
  readonly?: boolean | null
}): boolean {
  if (attrs.readonly) return false
  if (!TEXT_TYPES.has(attrs.type ?? 'text')) return false
  const tokens = (attrs.autocomplete ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.some((t) => NOT_SPOKEN_AUTOCOMPLETE.test(t))) return false
  if (attrs.inputmode && NOT_SPOKEN_INPUTMODE.has(attrs.inputmode)) return false
  return true
}
