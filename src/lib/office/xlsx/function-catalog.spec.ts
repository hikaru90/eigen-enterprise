import { describe, expect, it } from 'vitest'
import { FUNCTIONS, functionSig, functionsStartingWith, signatureText } from './function-catalog'

describe('function catalog', () => {
  it('lists Excel worksheet functions sorted by name, each once', () => {
    const names = FUNCTIONS.map((f) => f.name)
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    expect(new Set(names).size).toBe(names.length)
    expect(names.length).toBeGreaterThanOrEqual(400)
    for (const name of names) expect(name).toBe(name.toUpperCase())
  })

  it('has SUM with a repeating optional tail', () => {
    expect(functionSig('SUM')).toEqual({
      name: 'SUM',
      args: [{ name: 'number1' }, { name: 'number2', optional: true, repeat: true }],
    })
    expect(signatureText(functionSig('SUM')!)).toBe('SUM(number1, [number2], ...)')
  })

  it('has VLOOKUP, IF and XLOOKUP in tooltip form', () => {
    expect(signatureText(functionSig('vlookup')!)).toBe(
      'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])',
    )
    expect(signatureText(functionSig('IF')!)).toBe(
      'IF(logical_test, [value_if_true], [value_if_false])',
    )
    expect(signatureText(functionSig('XLOOKUP')!)).toBe(
      'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])',
    )
    expect(functionSig('IF')!.args[0]).toEqual({ name: 'logical_test' })
  })

  it('marks both arguments of a repeating pair', () => {
    const sumifs = functionSig('SUMIFS')!
    expect(sumifs.args.slice(-2)).toEqual([
      { name: 'criteria_range2', optional: true, repeat: true },
      { name: 'criteria2', optional: true, repeat: true },
    ])
    expect(signatureText(sumifs)).toBe(
      'SUMIFS(sum_range, criteria_range1, criteria1, [criteria_range2], [criteria2], ...)',
    )
    expect(functionSig('LAMBDA')!.args).toEqual([
      { name: 'parameter_or_calculation', repeat: true },
    ])
  })

  it('finds functions by prefix and by stored name', () => {
    expect(functionsStartingWith('VL')[0].name).toBe('VLOOKUP')
    expect(functionsStartingWith('s', 3).map((f) => f.name)).toEqual(['SCAN', 'SEARCH', 'SEARCHB'])
    expect(functionSig('_xlfn.xlookup')?.name).toBe('XLOOKUP')
    expect(functionSig('STDEV.S')?.name).toBe('STDEV.S')
    expect(functionSig('NOPE')).toBeNull()
    expect(signatureText(functionSig('TODAY')!)).toBe('TODAY()')
  })
})
