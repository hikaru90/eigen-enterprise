import type { FontInfo } from './model'

/**
 * CSS font stacks for the fonts a document names. The named font comes
 * first (used when it is installed), then fonts known to share its metrics
 * or design, then a generic family from the document's own font table
 * (w:family: roman → serif, swiss → sans-serif, modern → monospace, …).
 */

/** Metric-compatible or close substitutes, by exact font name (lower case). */
const SUBSTITUTES: Record<string, string[]> = {
  calibri: ['Carlito'],
  'calibri light': ['Calibri', 'Carlito'],
  cambria: ['Caladea'],
  'cambria math': ['Cambria', 'Caladea', 'STIX Two Math'],
  aptos: ['Calibri', 'Carlito'],
  'aptos display': ['Aptos', 'Calibri', 'Carlito'],
  arial: ['Liberation Sans', 'Arimo', 'Helvetica'],
  helvetica: ['Arial', 'Liberation Sans', 'Arimo'],
  'times new roman': ['Liberation Serif', 'Tinos', 'Times'],
  times: ['Times New Roman', 'Liberation Serif', 'Tinos'],
  'courier new': ['Liberation Mono', 'Cousine', 'Courier'],
  consolas: ['Menlo', 'Monaco', 'Liberation Mono'],
  georgia: ['Gelasio'],
  verdana: ['DejaVu Sans'],
  'segoe ui': ['system-ui', '-apple-system'],
  // East Asian
  'ms mincho': ['Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP', 'Noto Serif JP'],
  'ms pmincho': ['MS Mincho', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP'],
  'yu mincho': ['Hiragino Mincho ProN', 'MS Mincho', 'Noto Serif CJK JP', 'Noto Serif JP'],
  'ms gothic': ['Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans CJK JP', 'Noto Sans JP'],
  'ms pgothic': ['MS Gothic', 'Hiragino Sans', 'Yu Gothic', 'Noto Sans CJK JP'],
  'yu gothic': ['Hiragino Sans', 'MS Gothic', 'Noto Sans CJK JP', 'Noto Sans JP'],
  meiryo: ['Hiragino Sans', 'Yu Gothic', 'Noto Sans CJK JP'],
  simsun: ['Songti SC', 'STSong', 'Noto Serif CJK SC', 'Noto Serif SC'],
  nsimsun: ['SimSun', 'Songti SC', 'Noto Serif CJK SC'],
  simhei: ['Heiti SC', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC'],
  dengxian: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans SC'],
  'microsoft yahei': ['PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC'],
  kaiti: ['Kaiti SC', 'STKaiti'],
  pmingliu: ['MingLiU', 'Songti TC', 'Noto Serif CJK TC', 'Noto Serif TC'],
  mingliu: ['PMingLiU', 'Songti TC', 'Noto Serif CJK TC', 'Noto Serif TC'],
  'microsoft jhenghei': ['PingFang TC', 'Noto Sans CJK TC', 'Noto Sans TC'],
  batang: ['AppleMyungjo', 'Noto Serif CJK KR', 'Noto Serif KR'],
  'malgun gothic': ['Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Noto Sans KR'],
  gulim: ['Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR'],
  // Right-to-left scripts
  david: ['Arial Hebrew', 'Noto Sans Hebrew'],
  'traditional arabic': ['Geeza Pro', 'Noto Naskh Arabic', 'Amiri'],
  'simplified arabic': ['Geeza Pro', 'Noto Naskh Arabic', 'Amiri'],
  'arabic typesetting': ['Geeza Pro', 'Noto Naskh Arabic', 'Amiri'],
  'sakkal majalla': ['Geeza Pro', 'Noto Naskh Arabic'],
}

/** ST_FontFamily → CSS generic family. */
const GENERIC: Record<string, string> = {
  roman: 'serif',
  swiss: 'sans-serif',
  modern: 'monospace',
  script: 'cursive',
  decorative: 'fantasy',
}

const quote = (name: string) => `"${name.replace(/["\\]/g, '\\$&')}"`

function genericOf(name: string | undefined, table: Map<string, FontInfo>): string | null {
  if (!name) return null
  const info = table.get(name)
  if (!info) return null
  if (info.family && GENERIC[info.family]) return GENERIC[info.family]!
  if (info.pitch === 'fixed') return 'monospace'
  return null
}

/**
 * The font-family value for text set in `primary` with East Asian text in
 * `eastAsia` (the browser falls through per glyph, so CJK characters a Latin
 * font lacks come from the East Asian font).
 */
export function fontStack(primary: string | undefined, eastAsia: string | undefined, table: Map<string, FontInfo>): string {
  const names: string[] = []
  const add = (n: string | undefined) => {
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n)
  }
  for (const n of [primary, eastAsia]) {
    if (!n) continue
    add(n)
    const alt = table.get(n)?.altName
    if (alt) add(alt)
    for (const s of SUBSTITUTES[n.toLowerCase()] ?? []) add(s)
  }
  const generic = genericOf(primary, table) ?? genericOf(eastAsia, table) ?? 'sans-serif'
  return [...names.map((n) => (n.startsWith('-') || n === 'system-ui' ? n : quote(n))), generic].join(', ')
}
