import { strToU8, zipSync, type Zippable } from 'fflate'

/**
 * Builds small .xlsx packages for tests, written from scratch as
 * SpreadsheetML (ECMA-376 Part 1 §18): a workbook, its sheets, shared
 * strings, styles (one bold font, one solid fill, one custom number
 * format), a theme and any extra parts.
 */

export const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = `${R}/`

export type SheetSpec = {
  name: string
  /** Whole `<row>` elements (inside sheetData). */
  rows?: string
  /** Elements after sheetData (mergeCells, conditionalFormatting, hyperlinks …), in schema order. */
  after?: string
  /** Elements before sheetData (cols …). */
  before?: string
  state?: 'hidden' | 'veryHidden'
  rels?: Array<{ id: string; type: string; target: string }>
}

export type BookSpec = {
  sheets: SheetSpec[]
  strings?: string[]
  definedNames?: string
  /** Extra parts: name → XML text (or bytes) and content type. */
  parts?: Record<string, { xml: string; type: string }>
  calcChain?: boolean
  /** Leave the styles part out. */
  noStyles?: boolean
  /** Attributes of the workbook's calcPr (default: calcId="191029"). */
  calcPr?: string
  /** Extra relationships of the workbook part (metadata …). */
  workbookRels?: Array<{ type: string; target: string }>
}

/** A cell: `c('A1', 5)`, `c('B1', 'text')` (shared string index given), `f('C1', 'A1+B1', 7)`. */
export const num = (ref: string, v: number, s?: number) =>
  `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`
export const str = (ref: string, index: number, s?: number) =>
  `<c r="${ref}" t="s"${s ? ` s="${s}"` : ''}><v>${index}</v></c>`
export const fml = (ref: string, formula: string, cached?: number | string, s?: number) =>
  `<c r="${ref}"${typeof cached === 'string' ? ' t="str"' : ''}${s ? ` s="${s}"` : ''}><f>${esc(formula)}</f>${cached !== undefined ? `<v>${esc(String(cached))}</v>` : ''}</c>`
/** An inline-string cell (no shared-strings table needed). */
export const txt = (ref: string, text: string, s?: number) =>
  `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t>${esc(text)}</t></is></c>`
export const bool = (ref: string, v: boolean) => `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
/** A dynamic-array formula anchor (Excel 365): t="array" over its spill range, cell metadata `cm`. */
export const dyn = (
  ref: string,
  spill: string,
  formula: string,
  cached?: number | string,
  cm = 1,
) =>
  `<c r="${ref}" cm="${cm}"${typeof cached === 'string' ? ' t="str"' : ''}><f t="array" ref="${spill}">${esc(formula)}</f>${cached !== undefined ? `<v>${esc(String(cached))}</v>` : ''}</c>`
/** A legacy array (Ctrl+Shift+Enter) formula anchor over `range`. */
export const cse = (ref: string, range: string, formula: string, cached?: number) =>
  `<c r="${ref}"><f t="array" ref="${range}">${esc(formula)}</f>${cached !== undefined ? `<v>${cached}</v>` : ''}</c>`

/** The metadata part Excel writes for dynamic arrays (cell metadata 1 = XLDAPR, fDynamic). */
export const DA_METADATA = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<metadata xmlns="${'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`

/** What a book with dynamic-array formulas needs besides its sheets. */
export const daParts = (): Pick<BookSpec, 'parts' | 'workbookRels'> => ({
  parts: {
    '/xl/metadata.xml': {
      xml: DA_METADATA,
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml',
    },
  },
  workbookRels: [{ type: 'sheetMetadata', target: 'metadata.xml' }],
})

export const row = (r: number, cells: string, attrs = '') => `<row r="${r}"${attrs}>${cells}</row>`

export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Styles: xf 0 plain; 1 bold font; 2 yellow fill; 3 custom format "0.0%"; 4 date (built-in 14). */
export const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFC00000"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln/><a:ln/><a:ln/></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`

export function buildXlsx(spec: BookSpec): Uint8Array {
  const files: Zippable = {}
  const overrides: string[] = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ]
  const wbRels: string[] = []
  const sheetEls: string[] = []
  spec.sheets.forEach((s, i) => {
    const n = i + 1
    files[`xl/worksheets/sheet${n}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS}" xmlns:r="${R}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${s.before ?? ''}<sheetData>${s.rows ?? ''}</sheetData>${s.after ?? ''}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    )
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    wbRels.push(
      `<Relationship Id="rId${n}" Type="${REL}worksheet" Target="worksheets/sheet${n}.xml"/>`,
    )
    sheetEls.push(
      `<sheet name="${esc(s.name)}" sheetId="${n}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${n}"/>`,
    )
    if (s.rels?.length)
      files[`xl/worksheets/_rels/sheet${n}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${s.rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type.startsWith('http') ? r.type : REL + r.type}" Target="${r.target}"/>`).join('')}</Relationships>`,
      )
  })
  const k = spec.sheets.length
  wbRels.push(`<Relationship Id="rId${k + 1}" Type="${REL}theme" Target="theme/theme1.xml"/>`)
  files['xl/theme/theme1.xml'] = strToU8(THEME)
  if (!spec.noStyles) {
    wbRels.push(`<Relationship Id="rId${k + 2}" Type="${REL}styles" Target="styles.xml"/>`)
    overrides.push(
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
    )
    files['xl/styles.xml'] = strToU8(STYLES)
  }
  if (spec.strings) {
    wbRels.push(
      `<Relationship Id="rId${k + 3}" Type="${REL}sharedStrings" Target="sharedStrings.xml"/>`,
    )
    overrides.push(
      `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`,
    )
    files['xl/sharedStrings.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="${NS}" count="${spec.strings.length}" uniqueCount="${spec.strings.length}">${spec.strings.map((t) => (t.startsWith('<') ? `<si>${t}</si>` : `<si><t>${esc(t)}</t></si>`)).join('')}</sst>`,
    )
  }
  if (spec.calcChain) {
    wbRels.push(`<Relationship Id="rId${k + 4}" Type="${REL}calcChain" Target="calcChain.xml"/>`)
    overrides.push(
      `<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>`,
    )
    files['xl/calcChain.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<calcChain xmlns="${NS}"><c r="C1" i="1"/></calcChain>`,
    )
  }
  for (const [i, r] of (spec.workbookRels ?? []).entries())
    wbRels.push(
      `<Relationship Id="rId${k + 10 + i}" Type="${r.type.startsWith('http') ? r.type : REL + r.type}" Target="${r.target}"/>`,
    )
  for (const [name, p] of Object.entries(spec.parts ?? {})) {
    files[name.replace(/^\//, '')] = strToU8(p.xml)
    overrides.push(`<Override PartName="${name}" ContentType="${p.type}"/>`)
  }
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr/><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheetEls.join('')}</sheets>${spec.definedNames ? `<definedNames>${spec.definedNames}</definedNames>` : ''}<calcPr ${spec.calcPr ?? 'calcId="191029"'}/></workbook>`,
  )
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`,
  )
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  )
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides.join('')}</Types>`,
  )
  return zipSync(files)
}

/** The budget fixture most specs use: two sheets, strings, styles, formulas, a name, a merge. */
export function budgetBook(extra: Partial<BookSpec> = {}): Uint8Array {
  return buildXlsx({
    strings: ['Item', 'Cost', 'Rent', 'Food', 'Total'],
    definedNames: '<definedName name="Costs">Budget!$B$2:$B$3</definedName>',
    calcChain: true,
    sheets: [
      {
        name: 'Budget',
        before:
          '<cols><col min="1" max="1" width="20" customWidth="1"/><col min="3" max="4" width="12" customWidth="1"/></cols>',
        rows:
          row(1, str('A1', 0, 1) + str('B1', 1, 1)) +
          row(2, str('A2', 2) + num('B2', 1200, 2)) +
          row(3, str('A3', 3) + num('B3', 300)) +
          row(
            4,
            str('A4', 4, 1) +
              fml('B4', 'SUM(B2:B3)', 1500) +
              fml('C4', 'B4/12', 125) +
              fml('D4', 'SUM(Costs)', 1500),
          ),
        after: '<mergeCells count="1"><mergeCell ref="E1:F1"/></mergeCells>',
      },
      {
        name: 'Summary',
        rows: row(1, fml('A1', 'Budget!B4*2', 3000) + fml('B1', "'Budget'!C4", 125)),
      },
    ],
    ...extra,
  })
}
