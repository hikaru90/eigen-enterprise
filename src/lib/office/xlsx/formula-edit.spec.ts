import { describe, expect, it } from 'vitest'
import {
  acceptAutocomplete,
  activeFunctionCall,
  autocompleteContext,
  canInsertReferenceAt,
  cycleAbsoluteAt,
  formatPickedRef,
  formulaHighlightRuns,
  formulaReferences,
  insertReferenceAt,
} from './formula-edit'

describe('formula-edit: autocomplete, hints, reference colours, point-to-select, F4', () => {
  it('suggests matching functions and inserts FN(', () => {
    const ctx = autocompleteContext('=SUM(VL', 7)!
    expect(ctx.prefix).toBe('VL')
    expect(ctx.matches.map((m) => m.name)).toContain('VLOOKUP')
    expect(acceptAutocomplete('=SUM(VL', ctx, 'VLOOKUP')).toEqual({
      text: '=SUM(VLOOKUP(',
      cursor: 13,
    })
    // Never autocompletes inside string literals or cell addresses
    expect(autocompleteContext('="SUM', 5)).toBeNull()
    expect(autocompleteContext('=A1', 3)).toBeNull()
  })

  it('tracks the innermost active function call and repeating argument index', () => {
    const text = '=IF(SUM(A1, B2, C3)>0, VLOOKUP(D1, E1:F5, 2, FALSE), 0)'
    const sumCall = activeFunctionCall(text, 17)!
    expect(sumCall.sig.name).toBe('SUM')
    expect(sumCall.argIndex).toBe(2)
    expect(sumCall.highlightIndex).toBe(1) // [number2] repeating

    const vlCall = activeFunctionCall(text, 43)!
    expect(vlCall.sig.name).toBe('VLOOKUP')
    expect(vlCall.argIndex).toBe(2)
    expect(vlCall.highlightIndex).toBe(2)
  })

  it('assigns consistent colours to references in the formula and splits display runs', () => {
    const refs = formulaReferences('=A1+Summary!B2:C4+A1')
    expect(refs).toHaveLength(3)
    expect(refs[0]!.color).toBe(refs[2]!.color)
    expect(refs[0]!.color).not.toBe(refs[1]!.color)
    expect(refs[1]!.sheet).toBe('Summary')
    const runs = formulaHighlightRuns('=A1+B2')
    expect(runs).toEqual([
      { text: '=' },
      { text: 'A1', color: refs[0]!.color },
      { text: '+' },
      { text: 'B2', color: refs[1]!.color },
    ])
  })

  it('supports point-to-select reference insertion and dragging replacement', () => {
    expect(canInsertReferenceAt('=SUM(', 5)).toBe(true)
    expect(canInsertReferenceAt('="hello', 7)).toBe(false)
    const first = insertReferenceAt('=SUM(', 5, 5, 'A1')
    expect(first).toEqual({ text: '=SUM(A1', refStart: 5, refEnd: 7 })
    const dragged = insertReferenceAt(first.text, first.refEnd, first.refEnd, 'A1:B3', [
      first.refStart,
      first.refEnd,
    ])
    expect(dragged).toEqual({ text: '=SUM(A1:B3', refStart: 5, refEnd: 10 })
    expect(formatPickedRef('A1', 'Budget', 'Budget')).toBe('A1')
    expect(formatPickedRef('A1', 'Q1 Plan', 'Budget')).toBe("'Q1 Plan'!A1")
  })

  it('cycles $ locks on F4 for single cells and ranges', () => {
    const s1 = cycleAbsoluteAt('=A1+1', 3)!
    expect(s1.text).toBe('=$A$1+1')
    const s2 = cycleAbsoluteAt(s1.text, s1.selEnd)!
    expect(s2.text).toBe('=A$1+1')
    const s3 = cycleAbsoluteAt(s2.text, s2.selEnd)!
    expect(s3.text).toBe('=$A1+1')
    const s4 = cycleAbsoluteAt(s3.text, s3.selEnd)!
    expect(s4.text).toBe('=A1+1')

    const r1 = cycleAbsoluteAt('=SUM(A1:B2)', 10)!
    expect(r1.text).toBe('=SUM($A$1:$B$2)')
  })
})
