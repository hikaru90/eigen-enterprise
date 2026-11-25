import { DOMParser } from '@xmldom/xmldom'
import { strFromU8, unzipSync } from 'fflate'
import { hasOfficeSignature, OFFICE_LABEL } from '../kinds'
import { createSheetEditor } from './editor'
import { XlsxError } from './workbook'

/**
 * The spreadsheet formats that are not OOXML — Excel 97–2003 (.xls, BIFF8
 * in a Compound File) and OpenDocument (.ods) — shown and read through a
 * conversion to .xlsx, never edited in place (plan/phase-office-files.md §7).
 * The conversion is SheetJS Community Edition (Apache-2.0, vendored from
 * cdn.sheetjs.com, never the stale npm copy), loaded only when such a file is
 * opened. The result is checked by our own reader before anyone sees it.
 *
 * What a conversion keeps: sheets and their order and visibility, values,
 * formulas (in Excel's syntax), number formats, merged cells, column widths,
 * defined names. What it does not keep is listed (`CONVERSION_NOT_KEPT`) —
 * the grid shows it next to "Make an editable .xlsx copy", the tool returns it.
 */

export type LegacySheetKind = 'xls' | 'ods'

/** What an .xlsx copy of the file does not carry over. */
export type ConversionLoss =
  | 'cell_styles'
  | 'charts_images'
  | 'conditional_formats'
  | 'data_validations'
  | 'pivot_tables'
  | 'macros'

export const CONVERSION_NOT_KEPT: Readonly<Record<LegacySheetKind, readonly ConversionLoss[]>> = {
  xls: [
    'cell_styles',
    'charts_images',
    'conditional_formats',
    'data_validations',
    'pivot_tables',
    'macros',
  ],
  ods: [
    'cell_styles',
    'charts_images',
    'conditional_formats',
    'data_validations',
    'pivot_tables',
    'macros',
  ],
}

/** In sentences, for the tool's answer (the grid uses its own translated strings). */
export const CONVERSION_LOSS_TEXT: Readonly<Record<ConversionLoss, string>> = {
  cell_styles: 'cell formatting (fonts, colours, fills, borders, alignment)',
  charts_images: 'charts, pictures and drawings',
  conditional_formats: 'conditional formatting',
  data_validations: 'data validation (drop-down lists, input rules)',
  pivot_tables: 'pivot tables',
  macros: 'macros',
}

export type Conversion = { bytes: Uint8Array; notKept: readonly ConversionLoss[] }

/** `bytes` of an .xls or .ods as an .xlsx our editor opens. A broken file throws XlsxError with the reason. */
export async function convertToXlsx(kind: LegacySheetKind, bytes: Uint8Array): Promise<Conversion> {
  if (!hasOfficeSignature(kind, bytes))
    throw new XlsxError(
      kind === 'xls'
        ? `This is not an ${OFFICE_LABEL.xls} (.xls): it is not a Compound File.`
        : `This is not an ${OFFICE_LABEL.ods} (.ods): it is not a ZIP package.`,
    )
  const XLSX = await import('xlsx')
  let out: Uint8Array
  try {
    const book = XLSX.read(bytes, {
      type: 'array',
      cellFormula: true,
      cellNF: true,
      cellDates: false,
      cellStyles: false,
      bookVBA: false,
    })
    if (book.SheetNames.length === 0) throw new XlsxError('The file has no sheets.')
    if (kind === 'ods') {
      // SheetJS does not read ODF sheet visibility; hidden sheets stay hidden in the copy.
      const hidden = hiddenOdsTables(bytes)
      book.Workbook ??= {}
      book.Workbook.Sheets = book.SheetNames.map((name, i) => ({
        ...book.Workbook?.Sheets?.[i],
        name,
        Hidden: hidden.has(name) ? 1 : 0,
      }))
    }
    const written: ArrayBuffer = XLSX.write(book, {
      type: 'array',
      bookType: 'xlsx',
      compression: true,
    })
    out = new Uint8Array(written)
  } catch (err) {
    if (err instanceof XlsxError) throw err
    throw new XlsxError(
      `The ${OFFICE_LABEL[kind]} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  createSheetEditor(out)
  return { bytes: out, notKept: CONVERSION_NOT_KEPT[kind] }
}

const NS_TABLE = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
const NS_STYLE = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0'

/** The tables of an .ods whose table style says table:display="false" (ODF 1.2 Part 1 §17.15.1). */
function hiddenOdsTables(bytes: Uint8Array): Set<string> {
  const content = unzipSync(bytes, { filter: (f) => f.name === 'content.xml' })['content.xml']
  if (!content) throw new XlsxError('This OpenDocument spreadsheet has no content.xml.')
  const doc = new DOMParser().parseFromString(strFromU8(content), 'application/xml')
  const hiddenStyles = new Set<string>()
  const props = doc.getElementsByTagNameNS(NS_STYLE, 'table-properties')
  for (let i = 0; i < props.length; i++) {
    const p = props[i]!
    const style = p.parentNode as Element | null
    if (p.getAttributeNS(NS_TABLE, 'display') === 'false' && style)
      hiddenStyles.add(style.getAttributeNS(NS_STYLE, 'name') ?? '')
  }
  const out = new Set<string>()
  const tables = doc.getElementsByTagNameNS(NS_TABLE, 'table')
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]!
    if (hiddenStyles.has(t.getAttributeNS(NS_TABLE, 'style-name') ?? ''))
      out.add(t.getAttributeNS(NS_TABLE, 'name') ?? '')
  }
  return out
}

/** The copy's name next to the original: "budget.xls" → "budget.xlsx". */
export function xlsxCopyName(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.xlsx`
}
