/**
 * The composer's formatting buttons (bold, italic, code, link) insert
 * Markdown around the selection — messages are Markdown, so what you see in
 * the box is what gets rendered. Pure so it is unit-tested.
 */

export type Format = 'bold' | 'italic' | 'strike' | 'code' | 'link'

export type Edit = { text: string; selectionStart: number; selectionEnd: number }

const MARKS: Record<Exclude<Format, 'link'>, string> = { bold: '**', italic: '_', strike: '~~', code: '`' }

/** Wraps the selection (or inserts an empty pair with the caret inside). */
export function applyFormat(text: string, start: number, end: number, format: Format): Edit {
  const a = Math.max(0, Math.min(start, end, text.length))
  const b = Math.min(text.length, Math.max(start, end))
  const selected = text.slice(a, b)
  if (format === 'link') {
    const label = selected || 'link'
    const inserted = `[${label}](https://)`
    // Select the URL placeholder so typing replaces it.
    const urlStart = a + label.length + 3
    return { text: text.slice(0, a) + inserted + text.slice(b), selectionStart: urlStart, selectionEnd: urlStart + 'https://'.length }
  }
  const mark = format === 'code' && selected.includes('\n') ? '```' : MARKS[format]
  const open = mark === '```' ? '```\n' : mark
  const close = mark === '```' ? '\n```' : mark
  return {
    text: text.slice(0, a) + open + selected + close + text.slice(b),
    selectionStart: a + open.length,
    selectionEnd: a + open.length + selected.length,
  }
}

/** Inserts text at the caret (the emoji picker), replacing any selection. */
export function insertAt(text: string, start: number, end: number, insert: string): Edit {
  const a = Math.max(0, Math.min(start, end, text.length))
  const b = Math.min(text.length, Math.max(start, end))
  const caret = a + insert.length
  return { text: text.slice(0, a) + insert + text.slice(b), selectionStart: caret, selectionEnd: caret }
}
