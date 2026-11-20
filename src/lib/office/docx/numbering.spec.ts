import { describe, expect, it } from 'vitest'
import { formatNumber } from './numbering'

describe('docx numbering formats (ST_NumberFormat)', () => {
  it.each([
    [1, 'decimal', '1'],
    [7, 'decimalZero', '07'],
    [1994, 'upperRoman', 'MCMXCIV'],
    [49, 'lowerRoman', 'xlix'],
    [1, 'lowerLetter', 'a'],
    [26, 'upperLetter', 'Z'],
    [27, 'lowerLetter', 'aa'],
    [53, 'upperLetter', 'AAA'],
    [2, 'ordinal', '2nd'],
    [13, 'ordinal', '13th'],
    [3, 'decimalEnclosedCircle', '③'],
    [12, 'decimalFullWidth', '１２'],
    [105, 'ideographDigital', '一〇五'],
    [11, 'chineseCounting', '十一'],
    [25, 'japaneseCounting', '二十五'],
    [101, 'chineseCounting', '一百〇一'],
    [5, 'bullet', ''],
    [5, 'none', ''],
  ])('%i as %s → %s', (n, fmt, text) => {
    expect(formatNumber(n, fmt)).toEqual({ text, supported: true })
  })

  it('marks a format it does not implement, showing the decimal value', () => {
    expect(formatNumber(4, 'hebrew2')).toEqual({ text: '4', supported: false })
  })
})
