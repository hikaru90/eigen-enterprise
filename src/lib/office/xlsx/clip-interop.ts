import type { Clip, ClipCell } from './clip'
import type { Range } from './ref'
import type { RichRun } from './rich-text'
import type { BorderEdge, CellBorders, CellStyle, FontStyle } from './styles'
import { translateFormulaToA1 } from '@borgar/fx'
import Papa from 'papaparse'
import { parseInput, type SheetLocale } from './format'
import { isErrorValue, type CellValue } from './workbook'

/**
 * Clipboard interop with Excel, Google Sheets and Apple Numbers:
 * - Outgoing: `text/plain` TSV (RFC 4180 quoted when cells hold tabs/quotes/newlines)
 *   and `text/html` `<table>` with inline CSS, `colspan`/`rowspan` merges, `x:num`,
 *   `x:fmla`, `mso-number-format` and rich-text `<span>` runs.
 * - Incoming: parses `text/html` tables (inline styles, `<style>` class rules from
 *   Excel `.xl*` / Numbers `.td*`/`.s*`, `x:fmla`, `x:num`, `mso-number-format`,
 *   Google Sheets `data-sheets-formula`/`data-sheets-value`/`data-sheets-numberformat`,
 *   `colspan`/`rowspan` merges, rich text tags `<b>/<i>/<u>/<s>/<span>/<font>`),
 *   falling back to `text/plain` TSV.
 */

function valueText(v: CellValue): string {
  if (v === null) return ''
  if (isErrorValue(v)) return v.error
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function cellShownText(c: ClipCell | null): string {
  if (!c) return ''
  if (c.text !== undefined) return c.text
  return valueText(c.value)
}

/** `Clip` → tab-separated text (`text/plain`) compatible with Excel, Sheets, Numbers. */
export function clipToTsv(clip: Clip): string {
  return clip.cells
    .map((line) =>
      line
        .map((cell) => {
          const t = cellShownText(cell)
          return /[\t\r\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
        })
        .join('\t'),
    )
    .join('\n')
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function lookCss(look: CellStyle | null): string[] {
  if (!look) return []
  const css: string[] = []
  if (look.font.bold) css.push('font-weight:bold')
  if (look.font.italic) css.push('font-style:italic')
  const deco = [look.font.underline ? 'underline' : '', look.font.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  if (deco) css.push(`text-decoration:${deco}`)
  if (look.font.color) css.push(`color:${look.font.color}`)
  if (look.font.sizePt) css.push(`font-size:${look.font.sizePt}pt`)
  if (look.font.name) css.push(`font-family:"${look.font.name.replace(/"/g, '')}"`)
  if (look.fill) css.push(`background-color:${look.fill}`)
  if (look.horizontal && look.horizontal !== 'general') css.push(`text-align:${look.horizontal}`)
  if (look.vertical && look.vertical !== 'bottom')
    css.push(`vertical-align:${look.vertical === 'center' ? 'middle' : look.vertical}`)
  if (look.wrap) css.push('white-space:pre-wrap')
  if (look.numFmt && look.numFmt !== 'General') {
    if (look.numFmt === '@') css.push('mso-number-format:"\\@"')
    else css.push(`mso-number-format:"${look.numFmt.replace(/"/g, '\\"')}"`)
  }
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const e = look.border[side]
    if (!e) continue
    const w = e.style === 'thick' ? '2pt' : e.style === 'medium' ? '1.5pt' : '0.5pt'
    const st =
      e.style === 'dotted'
        ? 'dotted'
        : e.style === 'dashed'
          ? 'dashed'
          : e.style === 'double'
            ? 'double'
            : 'solid'
    css.push(`border-${side}:${w} ${st} ${e.color ?? '#000000'}`)
  }
  return css
}

function runHtml(r: RichRun): string {
  const css: string[] = []
  if (r.bold) css.push('font-weight:bold')
  if (r.italic) css.push('font-style:italic')
  const deco = [r.underline ? 'underline' : '', r.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  if (deco) css.push(`text-decoration:${deco}`)
  if (r.color) css.push(`color:${r.color}`)
  if (r.size) css.push(`font-size:${r.size}pt`)
  if (r.font) css.push(`font-family:"${r.font.replace(/"/g, '')}"`)
  const text = escHtml(r.text).replace(/\n/g, '<br>')
  return css.length > 0 ? `<span style="${escHtml(css.join(';'))}">${text}</span>` : text
}

/** `Clip` → HTML table fragment (`text/html`) compatible with Excel, Google Sheets and Numbers. */
export function clipToHtml(clip: Clip): string {
  const mergeStart = new Map<string, Range>()
  const covered = new Set<string>()
  for (const m of clip.merges) {
    mergeStart.set(`${m.top}:${m.left}`, m)
    for (let r = m.top; r <= m.bottom; r++)
      for (let c = m.left; c <= m.right; c++)
        if (r !== m.top || c !== m.left) covered.add(`${r}:${c}`)
  }
  const rowsHtml: string[] = []
  for (let r = 0; r < clip.rows; r++) {
    const cellsHtml: string[] = []
    for (let c = 0; c < clip.cols; c++) {
      const k = `${r}:${c}`
      if (covered.has(k)) continue
      const cell = clip.cells[r]?.[c] ?? null
      const m = mergeStart.get(k)
      const attrs: string[] = []
      if (m) {
        if (m.right > m.left) attrs.push(`colspan="${m.right - m.left + 1}"`)
        if (m.bottom > m.top) attrs.push(`rowspan="${m.bottom - m.top + 1}"`)
      }
      if (cell) {
        if (cell.formula !== null) attrs.push(`x:fmla="=${escHtml(cell.formula)}"`)
        if (typeof cell.value === 'number') attrs.push(`x:num="${cell.value}"`)
        const css = lookCss(cell.look)
        if (css.length > 0) attrs.push(`style="${escHtml(css.join(';'))}"`)
      }
      const body = cell?.runs?.length
        ? cell.runs.map(runHtml).join('')
        : escHtml(cellShownText(cell)).replace(/\n/g, '<br>')
      cellsHtml.push(`<td${attrs.length ? ` ${attrs.join(' ')}` : ''}>${body}</td>`)
    }
    rowsHtml.push(`<tr>${cellsHtml.join('')}</tr>`)
  }
  return `<html><head><meta charset="utf-8"></head><body><!--StartFragment--><table><tbody>${rowsHtml.join('')}</tbody></table><!--EndFragment--></body></html>`
}

// ---------------------------------------------------------------------------
// Incoming TSV & HTML parsing

export function clipFromTsv(tsv: string, locale: SheetLocale = 'en'): Clip | null {
  const trimmed = tsv.replace(/\r?\n$/, '')
  if (trimmed === '') return null
  const grid: string[][] = trimmed.includes('\t')
    ? Papa.parse<string[]>(trimmed, {
        delimiter: '\t',
        quoteChar: '"',
        escapeChar: '"',
        skipEmptyLines: false,
        header: false,
      }).data
    : trimmed.split(/\r?\n/).map((line) => [line])
  if (grid.length === 0) return null
  const cols = grid.reduce((w, r) => Math.max(w, r.length), 0)
  if (cols === 0) return null
  const cells = grid.map((line) => {
    const out: Array<ClipCell | null> = []
    for (let c = 0; c < cols; c++) {
      const raw = line[c] ?? ''
      if (raw === '') {
        out.push(null)
        continue
      }
      const parsed = parseInput(raw, locale)
      if (parsed.kind === 'formula') {
        out.push({
          value: null,
          text: raw,
          formula: parsed.formula,
          style: null,
          look: null,
        })
      } else {
        out.push({
          value: parsed.value,
          text: raw,
          formula: null,
          style: null,
          look: null,
          ...(parsed.format ? { implied: parsed.format } : {}),
        })
      }
    }
    return out
  })
  return {
    book: null,
    sheet: null,
    origin: { row: 0, col: 0 },
    rows: cells.length,
    cols,
    cells,
    merges: [],
  }
}

// ---------------------------------------------------------------------------
// Clean-room self-contained HTML table parser (runs identically in Node and Browser)

type HtmlNode =
  | { kind: 'text'; text: string }
  | { kind: 'el'; tag: string; attrs: Record<string, string>; children: HtmlNode[] }

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
}

function decodeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z0-9]+);/g, (m, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const cp = Number.parseInt(code.slice(2), 16)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    if (code.startsWith('#')) {
      const cp = Number.parseInt(code.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[code] ?? m
  })
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const key = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ''
    attrs[key] = decodeHtml(val)
  }
  return attrs
}

function parseHtmlFragment(html: string): HtmlNode[] {
  // Strip HTML comments (keep inner text if wrapped in <!--StartFragment--> markers by just stripping comment tags)
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, () => {
    // Google Sheets wraps <style><!--td {...}--></style> in a comment inside <style>
    return ''
  })
  const root: HtmlNode = { kind: 'el', tag: 'root', attrs: {}, children: [] }
  const stack: Array<Extract<HtmlNode, { kind: 'el' }>> = [root]
  const tagRe = /<(\/?)([A-Za-z][A-Za-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(cleaned))) {
    if (m.index > last) {
      const rawText = cleaned.slice(last, m.index)
      if (rawText)
        stack[stack.length - 1]!.children.push({ kind: 'text', text: decodeHtml(rawText) })
    }
    last = m.index + m[0].length
    const closing = m[1] === '/'
    const tag = m[2]!.toLowerCase()
    const selfClosing = m[4] === '/' || VOID_TAGS.has(tag)
    if (closing) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    // In raw text tags (<style>, <script>), advance to closing tag so CSS isn't parsed as tags.
    if (tag === 'style' || tag === 'script') {
      const closeRe = new RegExp(`</${tag}\\s*>`, 'i')
      const rest = cleaned.slice(last)
      const hit = closeRe.exec(rest)
      const inner = hit ? rest.slice(0, hit.index) : rest
      const el: Extract<HtmlNode, { kind: 'el' }> = {
        kind: 'el',
        tag,
        attrs: parseAttrs(m[3] ?? ''),
        children: [{ kind: 'text', text: inner }],
      }
      stack[stack.length - 1]!.children.push(el)
      if (hit) {
        last += hit.index + hit[0].length
        tagRe.lastIndex = last
      } else {
        last = cleaned.length
        break
      }
      continue
    }
    // Auto-close implicit HTML table/cell tags if malformed
    if ((tag === 'td' || tag === 'th') && stack.some((s) => s.tag === 'td' || s.tag === 'th')) {
      while (stack.length > 1 && stack[stack.length - 1]!.tag !== 'tr') stack.pop()
    } else if (tag === 'tr' && stack.some((s) => s.tag === 'tr')) {
      while (
        stack.length > 1 &&
        stack[stack.length - 1]!.tag !== 'tbody' &&
        stack[stack.length - 1]!.tag !== 'thead' &&
        stack[stack.length - 1]!.tag !== 'table'
      )
        stack.pop()
    }
    const el: Extract<HtmlNode, { kind: 'el' }> = {
      kind: 'el',
      tag,
      attrs: parseAttrs(m[3] ?? ''),
      children: [],
    }
    stack[stack.length - 1]!.children.push(el)
    if (!selfClosing) stack.push(el)
  }
  if (last < cleaned.length) {
    const rawText = cleaned.slice(last)
    if (rawText) stack[stack.length - 1]!.children.push({ kind: 'text', text: decodeHtml(rawText) })
  }
  return root.children
}

function collectEls(
  nodes: HtmlNode[],
  tag: string,
  out: Array<Extract<HtmlNode, { kind: 'el' }>> = [],
) {
  for (const n of nodes) {
    if (n.kind !== 'el') continue
    if (n.tag === tag) out.push(n)
    collectEls(n.children, tag, out)
  }
  return out
}

function parseCssDecls(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  // Split on `;` outside quotes
  let cur = ''
  let q: string | null = null
  const parts: string[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (q) {
      cur += ch
      if (ch === q && text[i - 1] !== '\\') q = null
    } else if (ch === '"' || ch === "'") {
      q = ch
      cur += ch
    } else if (ch === ';') {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) parts.push(cur)
  for (const part of parts) {
    const idx = part.indexOf(':')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim().toLowerCase()
    const v = part.slice(idx + 1).trim()
    if (k && v) out[k] = v
  }
  return out
}

function parseCssSheet(nodes: HtmlNode[]): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>()
  for (const st of collectEls(nodes, 'style')) {
    const raw = st.children
      .map((c) => (c.kind === 'text' ? c.text : ''))
      .join('')
      .replace(/^\s*<!--|--\s*>\s*$/g, '')
    const re = /([^{}]+)\{([^{}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw))) {
      const decls = parseCssDecls(m[2]!)
      for (const sel of m[1]!.split(',')) {
        const key = sel.trim().toLowerCase()
        if (!key) continue
        rules.set(key, { ...(rules.get(key) ?? {}), ...decls })
      }
    }
  }
  return rules
}

function styleFor(
  el: Extract<HtmlNode, { kind: 'el' }>,
  sheet: Map<string, Record<string, string>>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(sheet.get(el.tag) ?? {}) }
  const cls = (el.attrs.class ?? '').trim().split(/\s+/).filter(Boolean)
  for (const c of cls) {
    const lower = c.toLowerCase()
    Object.assign(merged, sheet.get(`.${lower}`) ?? {}, sheet.get(`${el.tag}.${lower}`) ?? {})
  }
  if (el.attrs.style) Object.assign(merged, parseCssDecls(el.attrs.style))
  return merged
}

function parseHexColor(raw: string | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (s === 'transparent' || s === 'none' || s === 'auto' || s === 'windowtext') return null
  const m6 = /^#([0-9a-f]{6})$/.exec(s)
  if (m6) return `#${m6[1]!.toUpperCase()}`
  const m3 = /^#([0-9a-f]{3})$/.exec(s)
  if (m3) {
    const [a, b, c] = m3[1]!
    return `#${a}${a}${b}${b}${c}${c}`.toUpperCase()
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/.exec(s)
  if (rgb) {
    if (rgb[4] !== undefined && Number(rgb[4]) === 0) return null
    const hex = [rgb[1], rgb[2], rgb[3]]
      .map((n) =>
        Math.max(0, Math.min(255, Number(n)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
    return `#${hex}`
  }
  const NAMED: Record<string, string> = {
    black: '#000000',
    white: '#FFFFFF',
    red: '#FF0000',
    green: '#008000',
    blue: '#0000FF',
    yellow: '#FFFF00',
    gray: '#808080',
    grey: '#808080',
  }
  return NAMED[s] ?? null
}

function parseFontSizePt(raw: string | undefined): number | null {
  if (!raw) return null
  const pt = /^([0-9.]+)\s*pt$/i.exec(raw.trim())
  if (pt) return Math.round(Number(pt[1]) * 10) / 10
  const px = /^([0-9.]+)\s*px$/i.exec(raw.trim())
  if (px) return Math.round(Number(px[1]) * 0.75 * 10) / 10
  return null
}

function parseBorderEdge(raw: string | undefined): BorderEdge | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  if (s === 'none' || s.startsWith('0')) return null
  const tokens = s.split(/\s+/)
  let style = 'thin'
  let color: string | null = null
  let widthPt = 0.5
  for (const t of tokens) {
    if (t === 'none' || t === 'hidden') return null
    if (t === 'dotted') style = 'dotted'
    else if (t === 'dashed') style = 'dashed'
    else if (t === 'double') style = 'double'
    else if (t.endsWith('pt')) widthPt = Number.parseFloat(t)
    else if (t.endsWith('px')) widthPt = Number.parseFloat(t) * 0.75
    else if (t === 'medium') widthPt = 1.5
    else if (t === 'thick') widthPt = 2.5
    else {
      const c = parseHexColor(t)
      if (c) color = c
    }
  }
  if (style === 'thin') {
    if (widthPt >= 2) style = 'thick'
    else if (widthPt >= 1.25) style = 'medium'
  }
  return { style, color }
}

function parseLook(
  decls: Record<string, string>,
  tdAttrs: Record<string, string>,
): CellStyle | null {
  const fw = (decls['font-weight'] ?? '').toLowerCase()
  const bold = fw === 'bold' || Number(fw) >= 600
  const italic = (decls['font-style'] ?? '').toLowerCase() === 'italic'
  const td = (decls['text-decoration'] ?? decls['text-decoration-line'] ?? '').toLowerCase()
  const underline = td.includes('underline')
  const strike = td.includes('line-through')
  const color = parseHexColor(decls.color)
  const sizePt = parseFontSizePt(decls['font-size'])
  const rawFamily = decls['font-family']?.split(',')[0]?.replace(/["']/g, '').trim() || null
  const fill = parseHexColor(decls['background-color'] ?? decls.background)
  const align = (decls['text-align'] ?? tdAttrs.align ?? '').toLowerCase()
  const horizontal =
    align === 'left' || align === 'center' || align === 'right' || align === 'justify'
      ? align
      : null
  const valign = (decls['vertical-align'] ?? tdAttrs.valign ?? '').toLowerCase()
  const vertical =
    valign === 'top'
      ? 'top'
      : valign === 'middle'
        ? 'center'
        : valign === 'bottom'
          ? 'bottom'
          : null
  const wrap =
    (decls['white-space'] ?? '').toLowerCase().includes('pre-wrap') ||
    (decls['white-space'] ?? '').toLowerCase() === 'normal'
      ? (decls['white-space'] ?? '').toLowerCase().includes('wrap')
      : false

  const borderAll = parseBorderEdge(decls.border)
  const border: CellBorders = {
    top: parseBorderEdge(decls['border-top']) ?? borderAll,
    right: parseBorderEdge(decls['border-right']) ?? borderAll,
    bottom: parseBorderEdge(decls['border-bottom']) ?? borderAll,
    left: parseBorderEdge(decls['border-left']) ?? borderAll,
  }

  let numFmt = 'General'
  const mso = decls['mso-number-format']
  if (mso) {
    const clean = mso
      .replace(/^["']|["']$/g, '')
      .replace(/\\"/g, '"')
      .replace(/\\@/g, '@')
    if (clean) numFmt = clean
  } else if (tdAttrs['data-sheets-numberformat']) {
    try {
      const parsed = JSON.parse(tdAttrs['data-sheets-numberformat']) as { '2'?: string }
      if (typeof parsed['2'] === 'string' && parsed['2']) numFmt = parsed['2']
    } catch {
      // ignore malformed JSON metadata
    }
  }

  const font: FontStyle = {
    bold,
    italic,
    underline,
    strike,
    color,
    sizePt,
    name: rawFamily,
  }
  const hasAny =
    bold ||
    italic ||
    underline ||
    strike ||
    color !== null ||
    sizePt !== null ||
    rawFamily !== null ||
    fill !== null ||
    horizontal !== null ||
    vertical !== null ||
    wrap ||
    numFmt !== 'General' ||
    border.top !== null ||
    border.right !== null ||
    border.bottom !== null ||
    border.left !== null
  if (!hasAny) return null
  return {
    numFmtId: 0,
    numFmt,
    font,
    fill,
    border,
    horizontal,
    vertical,
    wrap,
    indent: 0,
  }
}

type RunFmt = Omit<RichRun, 'text'>

function extractRuns(
  nodes: HtmlNode[],
  sheet: Map<string, Record<string, string>>,
  base: RunFmt,
  out: RichRun[],
) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      const text = n.text.replace(/\r?\n/g, '')
      if (text) out.push({ ...base, text })
      continue
    }
    if (n.tag === 'br') {
      out.push({ ...base, text: '\n' })
      continue
    }
    const decls = styleFor(n, sheet)
    const next: RunFmt = { ...base }
    if (n.tag === 'b' || n.tag === 'strong') next.bold = true
    if (n.tag === 'i' || n.tag === 'em') next.italic = true
    if (n.tag === 'u') next.underline = true
    if (n.tag === 's' || n.tag === 'strike' || n.tag === 'del') next.strike = true
    const fw = (decls['font-weight'] ?? '').toLowerCase()
    if (fw === 'bold' || Number(fw) >= 600) next.bold = true
    else if (fw === 'normal' || Number(fw) < 600) delete next.bold
    if ((decls['font-style'] ?? '').toLowerCase() === 'italic') next.italic = true
    const td = (decls['text-decoration'] ?? decls['text-decoration-line'] ?? '').toLowerCase()
    if (td.includes('underline')) next.underline = true
    if (td.includes('line-through')) next.strike = true
    const c = parseHexColor(decls.color ?? n.attrs.color)
    if (c) next.color = c
    const sz = parseFontSizePt(decls['font-size'])
    if (sz) next.size = sz
    const ff = decls['font-family']?.split(',')[0]?.replace(/["']/g, '').trim()
    if (ff) next.font = ff
    extractRuns(n.children, sheet, next, out)
    if (n.tag === 'p' || n.tag === 'div') {
      // Block separation inside cell if followed by more content
      out.push({ ...base, text: '\n' })
    }
  }
}

function normalizeExtractedRuns(
  runs: RichRun[],
  cellStyle: CellStyle | null,
): RichRun[] | undefined {
  // Trim trailing synthetic block newline added after </p> / </div>
  while (runs.length > 0 && runs[runs.length - 1]!.text === '\n') runs.pop()
  const compact: RichRun[] = []
  for (const r of runs) {
    if (!r.text) continue
    const last = compact[compact.length - 1]
    if (
      last &&
      !!last.bold === !!r.bold &&
      !!last.italic === !!r.italic &&
      !!last.underline === !!r.underline &&
      !!last.strike === !!r.strike &&
      last.color === r.color &&
      last.size === r.size &&
      last.font === r.font
    ) {
      last.text += r.text
    } else compact.push({ ...r })
  }
  if (compact.length <= 1) return undefined
  // Strip properties identical to the whole cell's format
  return compact.map((r) => {
    const out: RichRun = { text: r.text }
    if (r.bold && !cellStyle?.font.bold) out.bold = true
    if (r.italic && !cellStyle?.font.italic) out.italic = true
    if (r.underline && !cellStyle?.font.underline) out.underline = true
    if (r.strike && !cellStyle?.font.strike) out.strike = true
    if (r.color && r.color !== cellStyle?.font.color) out.color = r.color
    if (r.size && r.size !== cellStyle?.font.sizePt) out.size = r.size
    if (r.font && r.font !== cellStyle?.font.name) out.font = r.font
    return out
  })
}

function googleSheetsValue(raw: string | undefined): CellValue | undefined {
  if (!raw) return undefined
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const kind = obj['1']
    if (kind === 2 && typeof obj['2'] === 'string') return obj['2']
    if (kind === 3 && typeof obj['3'] === 'number') return obj['3']
    if (kind === 4 && typeof obj['4'] === 'number') return obj['4'] !== 0
    if (kind === 4 && typeof obj['4'] === 'boolean') return obj['4']
    if (kind === 6 && typeof obj['6'] === 'string') return { error: obj['6'] }
  } catch {
    // ignore malformed JSON
  }
  return undefined
}

function colRowName(row: number, col: number): string {
  let n = col + 1
  let colStr = ''
  while (n > 0) {
    const r = (n - 1) % 26
    colStr = String.fromCharCode(65 + r) + colStr
    n = Math.floor((n - 1) / 26)
  }
  return `${colStr}${row + 1}`
}

/** Parses HTML clipboard (`text/html`) from Excel, Google Sheets, Apple Numbers, or HTML tables. */
export function clipFromHtml(html: string, locale: SheetLocale = 'en'): Clip | null {
  const nodes = parseHtmlFragment(html)
  const tables = collectEls(nodes, 'table')
  if (tables.length === 0) return null
  const sheet = parseCssSheet(nodes)
  const trs = collectEls(tables[0]!.children, 'tr')
  if (trs.length === 0) return null

  const occupied = new Set<string>()
  const cells: Array<Array<ClipCell | null>> = []
  const merges: Range[] = []
  let maxCols = 0

  trs.forEach((tr, r) => {
    while (cells.length <= r) cells.push([])
    let c = 0
    const tds = tr.children.filter(
      (n): n is Extract<HtmlNode, { kind: 'el' }> =>
        n.kind === 'el' && (n.tag === 'td' || n.tag === 'th'),
    )
    for (const td of tds) {
      while (occupied.has(`${r}:${c}`)) c++
      const colspan = Math.max(1, Number.parseInt(td.attrs.colspan ?? '1', 10) || 1)
      const rowspan = Math.max(1, Number.parseInt(td.attrs.rowspan ?? '1', 10) || 1)
      for (let dr = 0; dr < rowspan; dr++) {
        while (cells.length <= r + dr) cells.push([])
        for (let dc = 0; dc < colspan; dc++) {
          occupied.add(`${r + dr}:${c + dc}`)
        }
      }
      if (rowspan > 1 || colspan > 1) {
        merges.push({ top: r, left: c, bottom: r + rowspan - 1, right: c + colspan - 1 })
      }
      const decls = styleFor(td, sheet)
      const look = parseLook(decls, td.attrs)
      const rawRuns: RichRun[] = []
      extractRuns(td.children, sheet, {}, rawRuns)
      const runs = normalizeExtractedRuns(rawRuns, look)
      const text = rawRuns
        .map((x) => x.text)
        .join('')
        .replace(/\u00a0/g, ' ')
        .trim()

      // Formula from Excel x:fmla or Google Sheets data-sheets-formula
      let formula: string | null = null
      const xFmla = td.attrs['x:fmla']
      const gsFmla = td.attrs['data-sheets-formula']
      if (xFmla && xFmla.startsWith('=')) {
        formula = xFmla.slice(1)
      } else if (gsFmla && gsFmla.startsWith('=')) {
        const body = gsFmla.slice(1)
        formula = /\bR(?:\[-?\d+\]|\d*)C(?:\[-?\d+\]|\d*)\b/.test(body)
          ? translateFormulaToA1(body, colRowName(r, c))
          : body
      }

      let value: CellValue = null
      let implied: string | undefined
      const xNum = td.attrs['x:num']
      const gsVal = googleSheetsValue(td.attrs['data-sheets-value'])
      if (xNum !== undefined && Number.isFinite(Number(xNum))) {
        value = Number(xNum)
      } else if (gsVal !== undefined) {
        value = gsVal
      } else if (formula === null) {
        if (look?.numFmt === '@') {
          value = text === '' ? null : text
        } else if (text !== '') {
          const parsed = parseInput(text, locale)
          if (parsed.kind === 'formula') formula = parsed.formula
          else {
            value = parsed.value
            implied = parsed.format
          }
        }
      } else if (text !== '') {
        const parsed = parseInput(text, locale)
        value = parsed.kind === 'value' ? parsed.value : text
      }

      const empty = value === null && formula === null && look === null
      while (cells[r]!.length <= c) cells[r]!.push(null)
      if (!empty) {
        cells[r]![c] = {
          value,
          ...(text !== '' ? { text } : {}),
          formula,
          style: null,
          look,
          ...(implied ? { implied } : {}),
          ...(runs && formula === null ? { runs } : {}),
        }
      }
      maxCols = Math.max(maxCols, c + colspan)
      c += colspan
    }
  })

  if (cells.length === 0 || maxCols === 0) return null
  for (const row of cells) while (row.length < maxCols) row.push(null)
  return {
    book: null,
    sheet: null,
    origin: { row: 0, col: 0 },
    rows: cells.length,
    cols: maxCols,
    cells,
    merges,
  }
}

/** Reads system clipboard (`text/html` preferred when it holds a table, else `text/plain` TSV). */
export function clipFromClipboard(
  data: { html?: string; text?: string },
  locale: SheetLocale = 'en',
): Clip | null {
  if (data.html) {
    const parsed = clipFromHtml(data.html, locale)
    if (parsed) return parsed
  }
  if (data.text) return clipFromTsv(data.text, locale)
  return null
}
