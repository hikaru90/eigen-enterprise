import { describe, expect, it } from 'vitest'
import { applyFormat, insertAt } from './composer'

describe('composer formatting', () => {
  it('wraps the selection and keeps it selected', () => {
    expect(applyFormat('make this bold', 5, 9, 'bold')).toEqual({ text: 'make **this** bold', selectionStart: 7, selectionEnd: 11 })
    expect(applyFormat('a b', 2, 3, 'italic')).toEqual({ text: 'a _b_', selectionStart: 3, selectionEnd: 4 })
    expect(applyFormat('x', 0, 1, 'strike').text).toBe('~~x~~')
  })

  it('inserts an empty pair with the caret inside when nothing is selected', () => {
    expect(applyFormat('ab', 1, 1, 'code')).toEqual({ text: 'a``b', selectionStart: 2, selectionEnd: 2 })
  })

  it('uses a code block for multi-line code', () => {
    expect(applyFormat('l1\nl2', 0, 5, 'code').text).toBe('```\nl1\nl2\n```')
  })

  it('makes a link from the selection and selects the URL placeholder', () => {
    const e = applyFormat('see docs', 4, 8, 'link')
    expect(e.text).toBe('see [docs](https://)')
    expect(e.text.slice(e.selectionStart, e.selectionEnd)).toBe('https://')
    expect(applyFormat('', 0, 0, 'link').text).toBe('[link](https://)')
  })

  it('inserts an emoji at the caret, replacing a selection', () => {
    expect(insertAt('hi there', 3, 8, '👋')).toEqual({ text: 'hi 👋', selectionStart: 5, selectionEnd: 5 })
  })
})
