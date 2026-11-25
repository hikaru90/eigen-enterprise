/**
 * What each function parameter takes, as Excel defines it: a single value
 * (an array there is lifted element by element in a dynamic-array formula,
 * and a range is implicitly intersected in a single-cell formula from older
 * Excel), a range/array taken whole, or an array evaluated as an array even
 * in older Excel's single-cell formulas (SUMPRODUCT, LOOKUP, AGGREGATE's
 * array form, INDEX's array). Unlisted parameters take single values.
 */

export type ParamClass = 'value' | 'range' | 'array'

/** Index lists: "*" all, "1+" from 1 on, "0,2", "even" (0,2,4…), "0,odd" (0,1,3,5…). */
const RANGE: Record<string, string> = {
  // Aggregates over any number of ranges.
  ...Object.fromEntries(
    [
      'SUM',
      'SUMSQ',
      'PRODUCT',
      'AVERAGE',
      'AVERAGEA',
      'COUNT',
      'COUNTA',
      'COUNTBLANK',
      'MAX',
      'MAXA',
      'MIN',
      'MINA',
      'MEDIAN',
      'MODE',
      'MODE.SNGL',
      'MODE.MULT',
      'STDEV',
      'STDEV.S',
      'STDEV.P',
      'STDEVA',
      'STDEVP',
      'STDEVPA',
      'VAR',
      'VAR.S',
      'VAR.P',
      'VARA',
      'VARP',
      'VARPA',
      'AVEDEV',
      'DEVSQ',
      'GEOMEAN',
      'HARMEAN',
      'KURT',
      'SKEW',
      'SKEW.P',
      'CONCAT',
      'AND',
      'OR',
      'XOR',
      'SUMX2MY2',
      'SUMX2PY2',
      'SUMXMY2',
      'CORREL',
      'COVAR',
      'COVARIANCE.P',
      'COVARIANCE.S',
      'PEARSON',
      'RSQ',
      'SLOPE',
      'INTERCEPT',
      'STEYX',
      'FREQUENCY',
      'MMULT',
      'MDETERM',
      'MINVERSE',
      'GCD',
      'LCM',
      'IMSUM',
      'IMPRODUCT',
      'MULTINOMIAL',
      'T.TEST',
      'TTEST',
      'F.TEST',
      'FTEST',
      'CHISQ.TEST',
      'CHITEST',
      'LINEST',
      'LOGEST',
      'TREND',
      'GROWTH',
      'ROWS',
      'COLUMNS',
      'AREAS',
      'TYPE',
    ].map((n) => [n, '*']),
  ),
  TEXTJOIN: '2+',
  NPV: '1+',
  IRR: '0',
  MIRR: '0',
  XNPV: '1,2',
  XIRR: '0,1',
  FVSCHEDULE: '1',
  'Z.TEST': '0',
  ZTEST: '0',
  FORECAST: '1,2',
  'FORECAST.LINEAR': '1,2',
  LARGE: '0',
  SMALL: '0',
  PERCENTILE: '0',
  'PERCENTILE.INC': '0',
  'PERCENTILE.EXC': '0',
  QUARTILE: '0',
  'QUARTILE.INC': '0',
  'QUARTILE.EXC': '0',
  PERCENTRANK: '0',
  'PERCENTRANK.INC': '0',
  'PERCENTRANK.EXC': '0',
  RANK: '1',
  'RANK.EQ': '1',
  'RANK.AVG': '1',
  PROB: '0,1',
  TRIMMEAN: '0',
  COUNTIF: '0',
  SUMIF: '0,2',
  AVERAGEIF: '0,2',
  COUNTIFS: 'even',
  SUMIFS: '0,odd',
  AVERAGEIFS: '0,odd',
  MAXIFS: '0,odd',
  MINIFS: '0,odd',
  VLOOKUP: '1',
  HLOOKUP: '1',
  MATCH: '1',
  CHOOSE: '1+',
  SUBTOTAL: '1+',
  NETWORKDAYS: '2',
  'NETWORKDAYS.INTL': '3',
  WORKDAY: '2',
  'WORKDAY.INTL': '3',
  SERIESSUM: '3',
  ...Object.fromEntries(
    [
      'DSUM',
      'DAVERAGE',
      'DCOUNT',
      'DCOUNTA',
      'DGET',
      'DMAX',
      'DMIN',
      'DPRODUCT',
      'DSTDEV',
      'DSTDEVP',
      'DVAR',
      'DVARP',
    ].map((n) => [n, '0,2']),
  ),
}

const ARRAY: Record<string, string> = {
  SUMPRODUCT: '*',
  LOOKUP: '1,2',
  AGGREGATE: '2+',
  INDEX: '0',
}

function matches(spec: string, i: number): boolean {
  return spec.split(',').some((part) => {
    if (part === '*') return true
    if (part === 'even') return i % 2 === 0
    if (part === 'odd') return i % 2 === 1
    if (part.endsWith('+')) return i >= Number(part.slice(0, -1))
    return Number(part) === i
  })
}

export function paramClass(fn: string, i: number): ParamClass {
  const a = ARRAY[fn]
  if (a && matches(a, i)) return 'array'
  const r = RANGE[fn]
  if (r && matches(r, i)) return 'range'
  return 'value'
}

/**
 * Functions only dynamic-array Excel has (written with `_xlfn.`, older
 * Excel can't calculate them), whose formulas are written as dynamic arrays.
 */
export const DYNAMIC_ONLY = new Set([
  'FILTER',
  'SORT',
  'SORTBY',
  'UNIQUE',
  'SEQUENCE',
  'RANDARRAY',
  'XLOOKUP',
  'XMATCH',
  'LET',
  'LAMBDA',
  'MAP',
  'REDUCE',
  'SCAN',
  'BYROW',
  'BYCOL',
  'MAKEARRAY',
  'ISOMITTED',
  'TAKE',
  'DROP',
  'EXPAND',
  'VSTACK',
  'HSTACK',
  'TOCOL',
  'TOROW',
  'CHOOSECOLS',
  'CHOOSEROWS',
  'WRAPROWS',
  'WRAPCOLS',
  'TEXTSPLIT',
  'ANCHORARRAY',
])

/** Functions whose result is a reference (it can be a range). */
export const REF_RESULT = new Set(['OFFSET', 'INDIRECT', 'INDEX'])
