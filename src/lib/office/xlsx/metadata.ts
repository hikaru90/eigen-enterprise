import { strToU8 } from 'fflate'
import { relsPartOf, type OpcPackage } from '../ooxml/package'
import { relativeTarget, type Workbook } from './workbook'
import { all, insertInOrder, kid, kids, make, NS_MAIN, REL } from './xml'

/**
 * Dynamic-array formulas (Excel 365): a formula that spills is written as
 * `<f t="array" ref="spill range">` on a cell whose `cm` attribute points at
 * cell metadata of type XLDAPR whose future metadata says fDynamic="1"
 * (ECMA-376 Part 1 §18.9 metadata, [MS-XLSX] 2.6.86 dynamicArrayProperties).
 * Without it, the same `<f t="array">` is a legacy Ctrl+Shift+Enter array.
 */

export const REL_SHEET_METADATA = `${REL}sheetMetadata`
export const CT_SHEET_METADATA =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml'
const NS_XDA = 'http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray'
const EXT_DA = '{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}'
const XLDAPR = 'XLDAPR'
/** CT_Metadata's children in schema order. */
const METADATA_ORDER = [
  'metadataTypes',
  'metadataStrings',
  'mdxMetadata',
  'futureMetadata',
  'cellMetadata',
  'valueMetadata',
  'extLst',
] as const

export function metadataPart(pkg: OpcPackage, workbookPart: string): string | null {
  const rel = pkg.relationships(workbookPart).find((r) => r.type === REL_SHEET_METADATA && r.part)
  return rel?.part && pkg.has(rel.part) ? rel.part : null
}

/** The `cm` values (1-based cell-metadata indexes) that mark a dynamic-array formula. */
export function dynamicArrayCms(pkg: OpcPackage, workbookPart: string): Set<number> {
  const out = new Set<number>()
  const part = metadataPart(pkg, workbookPart)
  if (!part) return out
  const root = pkg.xml(part).documentElement!
  const types = kid(root, 'metadataTypes')
  const typeNames = (types ? kids(types, 'metadataType') : []).map((t) => t.getAttribute('name'))
  const dynamicBlocks = new Set<number>()
  for (const fm of kids(root, 'futureMetadata')) {
    if (fm.getAttribute('name') !== XLDAPR) continue
    kids(fm, 'bk').forEach((bk, i) => {
      for (const p of all(bk, 'dynamicArrayProperties', NS_XDA)) {
        const v = p.getAttribute('fDynamic')
        if (v === '1' || v === 'true') dynamicBlocks.add(i)
      }
    })
  }
  const cellMeta = kid(root, 'cellMetadata')
  const cellBlocks = cellMeta ? kids(cellMeta, 'bk') : []
  cellBlocks.forEach((bk, i) => {
    for (const rc of kids(bk, 'rc')) {
      const t = Number(rc.getAttribute('t'))
      const v = Number(rc.getAttribute('v'))
      if (typeNames[t - 1] === XLDAPR && dynamicBlocks.has(v)) out.add(i + 1)
    }
  })
  return out
}

const METADATA_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<metadata xmlns="${NS_MAIN}" xmlns:xda="${NS_XDA}"/>`

/**
 * The `cm` value for a dynamic-array formula, adding the metadata part, its
 * relationship and the XLDAPR entries when the workbook has none (inside the
 * open transaction).
 */
export function ensureDynamicArrayCm(wb: Workbook): number {
  const have = dynamicArrayCms(wb.pkg, wb.part)
  if (have.size > 0) return Math.min(...have)
  let part = metadataPart(wb.pkg, wb.part)
  if (!part) {
    part = '/xl/metadata.xml'
    for (let n = 2; wb.pkg.has(part); n++) part = `/xl/metadata${n}.xml`
    wb.write(part, strToU8(METADATA_XML), CT_SHEET_METADATA)
    wb.touch(relsPartOf(wb.part))
    wb.pkg.addRelationship(wb.part, REL_SHEET_METADATA, relativeTarget(wb.part, part))
  }
  const doc = wb.edit(part)
  const root = doc.documentElement!
  if (!root.lookupPrefix(NS_XDA) && root.getAttribute('xmlns:xda') === null)
    root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:xda', NS_XDA)

  let types = kid(root, 'metadataTypes')
  if (!types) {
    types = make(doc, 'metadataTypes')
    insertInOrder(root, types, METADATA_ORDER)
  }
  let typeIndex = kids(types, 'metadataType').findIndex((t) => t.getAttribute('name') === XLDAPR)
  if (typeIndex < 0) {
    const t = make(doc, 'metadataType')
    const attrs: Array<[string, string]> = [
      ['name', XLDAPR],
      ['minSupportedVersion', '120000'],
      ['copy', '1'],
      ['pasteAll', '1'],
      ['pasteValues', '1'],
      ['merge', '1'],
      ['splitFirst', '1'],
      ['rowColShift', '1'],
      ['clearFormats', '1'],
      ['clearComments', '1'],
      ['assign', '1'],
      ['coerce', '1'],
      ['cellMeta', '1'],
    ]
    for (const [k, v] of attrs) t.setAttribute(k, v)
    types.appendChild(t)
    typeIndex = kids(types, 'metadataType').length - 1
    types.setAttribute('count', String(typeIndex + 1))
  }

  let future = kids(root, 'futureMetadata').find((f) => f.getAttribute('name') === XLDAPR)
  if (!future) {
    future = make(doc, 'futureMetadata')
    future.setAttribute('name', XLDAPR)
    insertInOrder(root, future, METADATA_ORDER)
  }
  const bk = make(doc, 'bk')
  const extLst = make(doc, 'extLst')
  const ext = make(doc, 'ext')
  ext.setAttribute('uri', EXT_DA)
  const props = doc.createElementNS(NS_XDA, 'xda:dynamicArrayProperties')
  props.setAttribute('fDynamic', '1')
  props.setAttribute('fCollapsed', '0')
  ext.appendChild(props)
  extLst.appendChild(ext)
  bk.appendChild(extLst)
  future.appendChild(bk)
  const futureIndex = kids(future, 'bk').length - 1
  future.setAttribute('count', String(futureIndex + 1))

  let cells = kid(root, 'cellMetadata')
  if (!cells) {
    cells = make(doc, 'cellMetadata')
    insertInOrder(root, cells, METADATA_ORDER)
  }
  const cbk = make(doc, 'bk')
  const rc = make(doc, 'rc')
  rc.setAttribute('t', String(typeIndex + 1))
  rc.setAttribute('v', String(futureIndex))
  cbk.appendChild(rc)
  cells.appendChild(cbk)
  const n = kids(cells, 'bk').length
  cells.setAttribute('count', String(n))
  wb.forgetMetadata()
  return n
}
