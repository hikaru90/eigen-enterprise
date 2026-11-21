import { describe, expect, it } from 'vitest'
import { inputTakesDictation, spliceTranscript } from './dictation-insert'

describe('spliceTranscript: dictated text goes in where the cursor is', () => {
  it('fills an empty field with the transcript alone', () => {
    expect(spliceTranscript('', 0, 0, 'ship the release')).toEqual({ value: 'ship the release', caret: 16 })
  })

  it('appends after typed text with one space', () => {
    expect(spliceTranscript('Fix the login', 13, 13, 'and the dashboard')).toEqual({
      value: 'Fix the login and the dashboard',
      caret: 31,
    })
  })

  it('goes in between two words with a space on each side', () => {
    const r = spliceTranscript('Call Ana tomorrow', 8, 8, 'and Ben')
    expect(r.value).toBe('Call Ana and Ben tomorrow')
    expect(r.caret).toBe('Call Ana and Ben'.length)
  })

  it('adds no extra space next to whitespace that is already there', () => {
    expect(spliceTranscript('Call Ana ', 9, 9, 'today').value).toBe('Call Ana today')
    expect(spliceTranscript('Call  Ana', 5, 5, 'Ben and').value).toBe('Call Ben and Ana')
  })

  it('replaces the selected text', () => {
    expect(spliceTranscript('Meet on Monday please', 8, 14, 'Tuesday').value).toBe('Meet on Tuesday please')
  })

  it('keeps closing punctuation attached and opening brackets open', () => {
    expect(spliceTranscript('Hello, world', 5, 5, 'there').value).toBe('Hello there, world')
    expect(spliceTranscript('(', 1, 1, 'note').value).toBe('(note')
  })

  it('trims what the model heard; nothing heard changes nothing', () => {
    expect(spliceTranscript('Draft', 5, 5, '  more  ').value).toBe('Draft more')
    expect(spliceTranscript('Draft', 2, 2, '   ')).toEqual({ value: 'Draft', caret: 2 })
  })

  it('refuses a selection outside the text (a caller bug, not a silent clamp)', () => {
    expect(() => spliceTranscript('abc', 2, 9, 'x')).toThrow(/selection/)
    expect(() => spliceTranscript('abc', 2, 1, 'x')).toThrow(/selection/)
  })
})

describe('inputTakesDictation: which single-line fields get the mic', () => {
  it('a plain text field does', () => {
    expect(inputTakesDictation({})).toBe(true)
    expect(inputTakesDictation({ type: 'text' })).toBe(true)
  })

  it.each(['password', 'email', 'number', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week', 'search', 'hidden', 'color', 'range', 'checkbox', 'radio'])(
    'type=%s does not',
    (type) => {
      expect(inputTakesDictation({ type })).toBe(false)
    },
  )

  it('a one-time code, address or credential field does not, whatever its type', () => {
    for (const autocomplete of ['one-time-code', 'email', 'username', 'tel', 'url', 'current-password', 'new-password', 'cc-number', 'postal-code']) {
      expect(inputTakesDictation({ autocomplete })).toBe(false)
    }
    expect(inputTakesDictation({ autocomplete: 'off' })).toBe(true)
    expect(inputTakesDictation({ autocomplete: 'name' })).toBe(true)
  })

  it('a numeric, phone, address or link keyboard does not', () => {
    for (const inputmode of ['numeric', 'decimal', 'tel', 'email', 'url', 'none']) {
      expect(inputTakesDictation({ inputmode })).toBe(false)
    }
    expect(inputTakesDictation({ inputmode: 'text' })).toBe(true)
  })

  it('a read-only field does not', () => {
    expect(inputTakesDictation({ readonly: true })).toBe(false)
  })
})
