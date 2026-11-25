import { strToU8, zipSync } from 'fflate'

/**
 * Spreadsheets in the formats Drive shows through a conversion (../convert.ts).
 *
 * The .ods is written from scratch as ODF 1.2 (OASIS OpenDocument Part 1
 * §9 tables; Part 3 packaging: the uncompressed `mimetype` first, the
 * manifest, content.xml, styles.xml): sheet "Budget" with text, numbers and
 * an OpenFormula SUM, and a hidden sheet "Archive".
 *
 * The .xls (BIFF8 in a Compound File, [MS-XLS]) is written by SheetJS with
 * the same budget and a second sheet "Notes". SheetJS writes no formulas to
 * BIFF, so the Total cell's NUMBER record is replaced with a FORMULA record
 * of SUM(B2:B3) ([MS-XLS] §2.4.127: PtgArea + PtgFuncVar), and the sheets'
 * stream offsets in BOUNDSHEET are moved by the length it adds.
 */

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  of: 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
}

const s = (t: string) =>
  `<table:table-cell office:value-type="string"><text:p>${t}</text:p></table:table-cell>`
const n = (v: number) =>
  `<table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`
const f = (formula: string, v: number) =>
  `<table:table-cell table:formula="${formula}" office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`
const r = (...cells: string[]) => `<table:table-row>${cells.join('')}</table:table-row>`

export function odsBook(): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="${NS.office}" xmlns:table="${NS.table}" xmlns:text="${NS.text}" xmlns:style="${NS.style}" xmlns:of="${NS.of}" office:version="1.2"><office:automatic-styles><style:style style:name="ta1" style:family="table"><style:table-properties table:display="true"/></style:style><style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style></office:automatic-styles><office:body><office:spreadsheet><table:table table:name="Budget" table:style-name="ta1">${r(s('Item'), s('Cost'))}${r(s('Rent'), n(1200))}${r(s('Food'), n(450))}${r(s('Total'), f('of:=SUM([.B2:.B3])', 1650))}</table:table><table:table table:name="Archive" table:style-name="ta2">${r(s('Old'))}</table:table></office:spreadsheet></office:body></office:document-content>`
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="${NS.manifest}" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`
  const styles = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="${NS.office}" xmlns:style="${NS.style}" office:version="1.2"><office:styles/></office:document-styles>`
  return zipSync({
    mimetype: [strToU8('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }],
    'META-INF/manifest.xml': strToU8(manifest),
    'content.xml': strToU8(content),
    'styles.xml': strToU8(styles),
  })
}

export async function xlsBook(): Promise<Uint8Array> {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  const budget = XLSX.utils.aoa_to_sheet([
    ['Item', 'Cost'],
    ['Rent', 1200],
    ['Food', 450],
    ['Total', 1650],
  ])
  XLSX.utils.book_append_sheet(book, budget, 'Budget')
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Paid in March']]), 'Notes')
  const cfb = XLSX.CFB.read(
    new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'biff8' }) as ArrayBuffer),
    { type: 'array' },
  )
  const entry = XLSX.CFB.find(cfb, 'Workbook')
  entry.content = withSumFormula(new Uint8Array(entry.content), 3, 1)
  entry.size = entry.content.length
  return new Uint8Array(XLSX.CFB.write(cfb, { type: 'array' }) as ArrayBuffer)
}

const BOF = 0x0809
const BOUNDSHEET = 0x0085
const NUMBER = 0x0203
const FORMULA = 0x0006

type BiffRecord = { type: number; body: Uint8Array }

/** The Workbook stream with the NUMBER at (row, col) turned into =SUM(B2:B3), its cached value kept. */
function withSumFormula(stream: Uint8Array, row: number, col: number): Uint8Array {
  const records: BiffRecord[] = []
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  for (let at = 0; at + 4 <= stream.length;) {
    const len = view.getUint16(at + 2, true)
    records.push({ type: view.getUint16(at, true), body: stream.slice(at + 4, at + 4 + len) })
    at += 4 + len
  }
  const target = records.find((rec) => {
    if (rec.type !== NUMBER) return false
    const v = new DataView(rec.body.buffer)
    return v.getUint16(0, true) === row && v.getUint16(2, true) === col
  })
  if (!target) throw new Error(`legacy-fixtures: no NUMBER record at ${row},${col}`)
  // rgce: PtgArea B2:B3 (relative row and column), then PtgFuncVar SUM (1 argument, iftab 4).
  const rgce = [0x25, 1, 0, 2, 0, 0x01, 0xc0, 0x01, 0xc0, 0x42, 0x01, 0x04, 0x00]
  const body = new Uint8Array(22 + rgce.length)
  const b = new DataView(body.buffer)
  body.set(target.body.slice(0, 14)) // rw, col, ixfe, the cached number
  b.setUint16(14, 0, true) // grbit
  b.setUint32(16, 0, true) // chn
  b.setUint16(20, rgce.length, true) // cce
  body.set(rgce, 22)
  target.type = FORMULA
  target.body = body
  // Sheet substreams start at each BOF after the globals; BOUNDSHEET.lbPlyPos points there.
  const starts: number[] = []
  let size = 0
  records.forEach((rec, i) => {
    if (rec.type === BOF && i > 0) starts.push(size)
    size += 4 + rec.body.length
  })
  records
    .filter((rec) => rec.type === BOUNDSHEET)
    .forEach((rec, i) => new DataView(rec.body.buffer).setUint32(0, starts[i]!, true))
  const out = new Uint8Array(size)
  const o = new DataView(out.buffer)
  let at = 0
  for (const rec of records) {
    o.setUint16(at, rec.type, true)
    o.setUint16(at + 2, rec.body.length, true)
    out.set(rec.body, at + 4)
    at += 4 + rec.body.length
  }
  return out
}
