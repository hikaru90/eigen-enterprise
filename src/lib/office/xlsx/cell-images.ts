import { cellName, parseCell } from './ref'
import type { SheetInfo, Workbook } from './workbook'
import { all, kid, kids, NS_MAIN, REL, textOf } from './xml'

/**
 * Pictures in cells (Excel 365's "Place in Cell", the IMAGE function's
 * result): the cell carries value metadata (`vm`), which leads through the
 * metadata part's XLRICHVALUE block to a rich value of the `_localImage`
 * structure, whose `_rvRel:LocalImageIdentifier` is an index into the rich
 * value relationships — the picture part. Read for showing; the cell, its
 * metadata and the rich data parts are kept exactly as written.
 */

const NS_RD = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata'
const NS_RD2 = 'http://schemas.microsoft.com/office/spreadsheetml/2017/richdata2'
const NS_RVREL = 'http://schemas.microsoft.com/office/spreadsheetml/2022/richvaluerel'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL_RV = 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValue'
const REL_RV_STRUCT = 'http://schemas.microsoft.com/office/2017/06/relationships/rdRichValueStructure'
const REL_RV_REL = 'http://schemas.microsoft.com/office/2022/10/relationships/richValueRel'
const REL_METADATA = `${REL}sheetMetadata`

export type CellImage = { ref: string; row: number; col: number; part: string; contentType: string; alt: string }

type RichImages = { byVm: (vm: number) => { part: string; contentType: string; alt: string } | null }

function richImages(wb: Workbook): RichImages | null {
  const rels = wb.pkg.relationships(wb.part)
  const find = (type: string) => rels.find((r) => r.type === type && r.part && wb.pkg.has(r.part))?.part ?? null
  const meta = find(REL_METADATA)
  const rv = find(REL_RV)
  const struct = find(REL_RV_STRUCT)
  const rvRel = find(REL_RV_REL)
  if (!meta || !rv || !struct || !rvRel) return null
  const mroot = wb.pkg.xml(meta).documentElement!
  const types = kids(kid(mroot, 'metadataTypes') ?? mroot, 'metadataType').map((t) => t.getAttribute('name'))
  const future = kids(mroot, 'futureMetadata').find((f) => f.getAttribute('name') === 'XLRICHVALUE')
  const futureBks = future ? kids(future, 'bk') : []
  const valueBks = kids(kid(mroot, 'valueMetadata') ?? mroot, 'bk')
  const structures = all(wb.pkg.xml(struct), 's', NS_RD2).map((s) => ({
    t: s.getAttribute('t'),
    keys: kids(s, 'k', NS_RD2).map((k) => k.getAttribute('n')),
  }))
  const values = all(wb.pkg.xml(rv), 'rv', NS_RD).map((v) => ({
    s: Number(v.getAttribute('s')),
    v: kids(v, 'v', NS_RD).map(textOf),
  }))
  const relIds = all(wb.pkg.xml(rvRel), 'rel', NS_RVREL).map((r) => r.getAttributeNS(NS_R, 'id') ?? '')
  const relParts = new Map(wb.pkg.relationships(rvRel).map((r) => [r.id, r.part]))
  return {
    byVm(vm) {
      const rc = valueBks[vm - 1] ? kid(valueBks[vm - 1]!, 'rc') : null
      if (!rc || types[Number(rc.getAttribute('t')) - 1] !== 'XLRICHVALUE') return null
      const bk = futureBks[Number(rc.getAttribute('v'))]
      const rvb = bk?.getElementsByTagNameNS('http://schemas.microsoft.com/office/spreadsheetml/2017/richdata', 'rvb')[0]
      const value = rvb ? values[Number(rvb.getAttribute('i'))] : undefined
      const s = value ? structures[value.s] : undefined
      if (!value || !s || s.t !== '_localImage') return null
      const at = s.keys.indexOf('_rvRel:LocalImageIdentifier')
      const part = at >= 0 ? relParts.get(relIds[Number(value.v[at])] ?? '') : null
      if (!part || !wb.pkg.has(part)) return null
      const textAt = s.keys.indexOf('Text')
      return { part, contentType: wb.pkg.contentType(part), alt: textAt >= 0 ? (value.v[textAt] ?? '') : '' }
    },
  }
}

/** The pictures placed in the sheet's cells. */
export function readCellImages(wb: Workbook, info: SheetInfo): CellImage[] {
  const rich = richImages(wb)
  if (!rich) return []
  const out: CellImage[] = []
  for (const c of all(wb.pkg.xml(info.part), 'c', NS_MAIN)) {
    const vm = c.getAttribute('vm')
    const a = parseCell(c.getAttribute('r') ?? '')
    if (!vm || !a) continue
    const img = rich.byVm(Number(vm))
    if (img) out.push({ ref: cellName(a), row: a.row, col: a.col, ...img })
  }
  return out
}
