import {
  applyRunStyleLayer,
  mergeCell,
  mergeParagraph,
  mergeRun,
  mergeTable,
  parseCellProps,
  parseParagraphProps,
  parseRunProps,
  parseTableProps,
  type CellProps,
  type ParagraphProps,
  type RunProps,
  type TableProps,
  type ThemeFonts,
} from './properties'
import { wa, wc, wcs } from './xml'

/**
 * styles.xml (ECMA-376 Part 1 §17.7): document defaults, paragraph,
 * character and table styles with their w:basedOn chains, and the
 * formatting hierarchy that combines them with direct formatting.
 */

export type StyleType = 'paragraph' | 'character' | 'table' | 'numbering'

/** Table style regions (ST_TblStyleOverrideType). */
export type TableRegion =
  | 'wholeTable'
  | 'band1Vert'
  | 'band2Vert'
  | 'band1Horz'
  | 'band2Horz'
  | 'firstCol'
  | 'lastCol'
  | 'firstRow'
  | 'lastRow'
  | 'nwCell'
  | 'neCell'
  | 'swCell'
  | 'seCell'

/** Lowest to highest priority when several regions apply to one cell. */
export const REGION_ORDER: readonly TableRegion[] = [
  'wholeTable',
  'band1Vert',
  'band2Vert',
  'band1Horz',
  'band2Horz',
  'firstCol',
  'lastCol',
  'firstRow',
  'lastRow',
  'nwCell',
  'neCell',
  'swCell',
  'seCell',
]

export type Formatting = { pPr: ParagraphProps; rPr: RunProps; tblPr: TableProps; tcPr: CellProps }

export type Style = Formatting & {
  id: string
  type: StyleType
  name: string | null
  basedOn: string | null
  isDefault: boolean
  regions: Partial<Record<TableRegion, Formatting>>
  source: Element
}

export type StyleSheet = {
  docDefaults: { rPr: RunProps; pPr: ParagraphProps }
  styles: Map<string, Style>
  defaults: Partial<Record<StyleType, string>>
  /** A paragraph style with its chain merged (base first); the default paragraph style when id is absent/unknown. */
  paragraphStyle(id: string | undefined): { pPr: ParagraphProps; rPr: RunProps; id: string | null }
  characterStyle(id: string | undefined): RunProps
  tableStyle(id: string | undefined): { formatting: Formatting; regions: Partial<Record<TableRegion, Formatting>>; id: string | null }
}

const emptyFormatting = (): Formatting => ({ pPr: {}, rPr: {}, tblPr: {}, tcPr: {} })

function parseFormatting(el: Element, theme: ThemeFonts): Formatting {
  return {
    pPr: parseParagraphProps(wc(el, 'pPr'), theme),
    rPr: parseRunProps(wc(el, 'rPr'), theme),
    tblPr: parseTableProps(wc(el, 'tblPr')),
    tcPr: parseCellProps(wc(el, 'tcPr')),
  }
}

function mergeFormatting(a: Formatting, b: Formatting): Formatting {
  return {
    pPr: mergeParagraph(a.pPr, b.pPr),
    rPr: mergeRun(a.rPr, b.rPr),
    tblPr: mergeTable(a.tblPr, b.tblPr),
    tcPr: mergeCell(a.tcPr, b.tcPr),
  }
}

export function parseStyles(doc: XMLDocument | null, theme: ThemeFonts): StyleSheet {
  const styles = new Map<string, Style>()
  const defaults: Partial<Record<StyleType, string>> = {}
  let docDefaults = { rPr: {} as RunProps, pPr: {} as ParagraphProps }
  const root = doc?.documentElement ?? null
  if (root) {
    const dd = wc(root, 'docDefaults')
    if (dd) {
      docDefaults = {
        rPr: parseRunProps(wc(wc(dd, 'rPrDefault'), 'rPr'), theme),
        pPr: parseParagraphProps(wc(wc(dd, 'pPrDefault'), 'pPr'), theme),
      }
    }
    for (const el of wcs(root, 'style')) {
      const id = wa(el, 'styleId')
      const type = (wa(el, 'type') ?? 'paragraph') as StyleType
      if (!id || !['paragraph', 'character', 'table', 'numbering'].includes(type)) continue
      const isDefault = isOn(wa(el, 'default'))
      const regions: Style['regions'] = {}
      for (const r of wcs(el, 'tblStylePr')) {
        const t = wa(r, 'type') as TableRegion | null
        if (t && REGION_ORDER.includes(t)) regions[t] = parseFormatting(r, theme)
      }
      styles.set(id, {
        id,
        type,
        name: wa(wc(el, 'name'), 'val'),
        basedOn: wa(wc(el, 'basedOn'), 'val'),
        isDefault,
        ...parseFormatting(el, theme),
        regions,
        source: el,
      })
      if (isDefault && !defaults[type]) defaults[type] = id
    }
  }

  /** The chain from the root ancestor down to `id` (cycles and type mismatches cut). */
  function chain(id: string, type: StyleType): Style[] {
    const out: Style[] = []
    const seen = new Set<string>()
    let cur: string | null = id
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      const s = styles.get(cur)
      if (!s || s.type !== type) break
      out.unshift(s)
      cur = s.basedOn
    }
    return out
  }

  const cache = new Map<string, unknown>()
  function memo<T>(key: string, fn: () => T): T {
    if (!cache.has(key)) cache.set(key, fn())
    return cache.get(key) as T
  }

  const pick = (id: string | undefined, type: StyleType) => {
    if (id && styles.get(id)?.type === type) return id
    return defaults[type] ?? null
  }

  return {
    docDefaults,
    styles,
    defaults,
    paragraphStyle(id) {
      const use = pick(id, 'paragraph')
      return memo(`p:${use}`, () => {
        let f = emptyFormatting()
        if (use) for (const s of chain(use, 'paragraph')) f = mergeFormatting(f, s)
        // A style's numPr without ilvl means level 0 (§17.9.23 in a style context).
        if (f.pPr.numbering && f.pPr.numbering.ilvl === undefined) f.pPr.numbering = { ...f.pPr.numbering, ilvl: 0 }
        return { pPr: f.pPr, rPr: f.rPr, id: use }
      })
    },
    characterStyle(id) {
      const use = pick(id, 'character')
      return memo(`c:${use}`, () => {
        let r: RunProps = {}
        if (use) for (const s of chain(use, 'character')) r = mergeRun(r, s.rPr)
        return r
      })
    },
    tableStyle(id) {
      const use = pick(id, 'table')
      return memo(`t:${use}`, () => {
        let f = emptyFormatting()
        const regions: Partial<Record<TableRegion, Formatting>> = {}
        if (use) {
          for (const s of chain(use, 'table')) {
            f = mergeFormatting(f, s)
            for (const [k, v] of Object.entries(s.regions) as [TableRegion, Formatting][]) {
              regions[k] = mergeFormatting(regions[k] ?? emptyFormatting(), v)
            }
          }
        }
        return { formatting: f, regions, id: use }
      })
    },
  }
}

const isOn = (v: string | null) => v === '1' || v === 'true' || v === 'on'

/** Formatting a table cell contributes to its paragraphs and runs (table style regions, in priority order). */
export type TableLayer = { pPr: ParagraphProps; rPr: RunProps }

/**
 * A paragraph's effective properties (§17.7.2): document defaults, then the
 * table style (inside a table), the paragraph style chain, the numbering
 * level's paragraph properties, then direct formatting.
 */
export function resolveParagraphProps(
  sheet: StyleSheet,
  direct: ParagraphProps,
  tableLayers: readonly TableLayer[],
  numberingPPr: ParagraphProps | null,
): ParagraphProps {
  let p = sheet.docDefaults.pPr
  for (const l of tableLayers) p = mergeParagraph(p, l.pPr)
  const style = sheet.paragraphStyle(direct.styleId)
  p = mergeParagraph(p, style.pPr)
  if (numberingPPr) p = mergeParagraph(p, numberingPPr)
  p = mergeParagraph(p, direct)
  if (style.id) p.styleId = style.id
  return p
}

/** The run properties a paragraph's styles give its runs before character styles and direct formatting. */
export function paragraphRunBase(sheet: StyleSheet, paragraphStyleId: string | undefined, tableLayers: readonly TableLayer[]): RunProps {
  let r: RunProps = sheet.docDefaults.rPr
  for (const l of tableLayers) r = applyRunStyleLayer(r, l.rPr)
  return applyRunStyleLayer(r, sheet.paragraphStyle(paragraphStyleId).rPr)
}

/** A run's effective properties: the paragraph's base, its character style (toggles flip), then direct formatting (absolute). */
export function resolveRunProps(sheet: StyleSheet, base: RunProps, characterStyleId: string | undefined, direct: RunProps): RunProps {
  // The default character style applies to runs that name none (§17.7.4.17).
  return mergeRun(applyRunStyleLayer(base, sheet.characterStyle(characterStyleId)), direct)
}
