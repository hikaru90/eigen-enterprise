/**
 * WordprocessingML XML helpers (ECMA-376 Part 1). The DOM comes from the
 * OPC layer (@xmldom/xmldom in Node and the browser alike), so nothing here
 * uses `instanceof` on DOM classes — only node types and namespaces.
 */

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  v: 'urn:schemas-microsoft-com:vml',
  o: 'urn:schemas-microsoft-com:office:office',
  m: 'http://schemas.openxmlformats.org/officeDocument/2006/math',
  xml: 'http://www.w3.org/XML/1998/namespace',
  /** ISO/IEC 29500 Strict: a different namespace and partly different units. */
  wStrict: 'http://purl.oclc.org/ooxml/wordprocessingml/main',
} as const

/** Relationship types (ECMA-376 Part 1 §11.3, transitional). */
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const REL = {
  styles: `${RT}/styles`,
  numbering: `${RT}/numbering`,
  settings: `${RT}/settings`,
  fontTable: `${RT}/fontTable`,
  theme: `${RT}/theme`,
  header: `${RT}/header`,
  footer: `${RT}/footer`,
  footnotes: `${RT}/footnotes`,
  endnotes: `${RT}/endnotes`,
  comments: `${RT}/comments`,
  image: `${RT}/image`,
  hyperlink: `${RT}/hyperlink`,
} as const

/** a:graphicData@uri values (ECMA-376 Part 1 §20, §21): what a drawing holds. */
export const GRAPHIC = {
  picture: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  shape: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  group: 'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
  canvas: 'http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas',
} as const

const ELEMENT_NODE = 1

export function children(el: Element): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === ELEMENT_NODE) out.push(n as Element)
  return out
}

export const isEl = (el: Element, ns: string, local: string) => el.namespaceURI === ns && el.localName === local

export function child(el: Element | null | undefined, ns: string, local: string): Element | null {
  if (!el) return null
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === ELEMENT_NODE && isEl(n as Element, ns, local)) return n as Element
  }
  return null
}

export const kids = (el: Element | null | undefined, ns: string, local: string): Element[] =>
  el ? children(el).filter((c) => isEl(c, ns, local)) : []

/** A w: child. */
export const wc = (el: Element | null | undefined, local: string) => child(el, NS.w, local)
export const wcs = (el: Element | null | undefined, local: string) => kids(el, NS.w, local)

/** An attribute by namespace, or null when absent (xmldom's getAttributeNS gives '' for absent). */
export function attr(el: Element | null | undefined, ns: string | null, local: string): string | null {
  if (!el) return null
  const node = ns ? el.getAttributeNodeNS(ns, local) : el.getAttributeNode(local)
  return node ? node.value : null
}

/** A w: attribute. */
export const wa = (el: Element | null | undefined, local: string) => attr(el, NS.w, local)

/** All descendants with this namespace and local name, in document order. */
export function descendants(el: Element, ns: string, local: string): Element[] {
  const list = el.getElementsByTagNameNS(ns, local)
  const out: Element[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i]!)
  return out
}

/** ST_OnOff (§17.17.4): an element present without w:val is on. */
export function onOff(el: Element | null): boolean | undefined {
  if (!el) return undefined
  const v = wa(el, 'val')
  if (v === null) return true
  return !(v === 'false' || v === '0' || v === 'off')
}

const UNIT_PT: Record<string, number> = { pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, pc: 12, pi: 12 }

/**
 * A measurement in twentieths of a point (ST_TwipsMeasure / ST_SignedTwipsMeasure)
 * or an ST_UniversalMeasure ("1.5in"), in points. Null when absent or unreadable.
 */
export function twipsPt(v: string | null): number | null {
  if (v === null || v === '') return null
  const m = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)?$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? n * UNIT_PT[m[2]]! : n / 20
}

/** ST_HpsMeasure: half-points, in points. */
export function halfPointsPt(v: string | null): number | null {
  if (v === null || v === '') return null
  const m = /^(-?\d+(?:\.\d+)?)(mm|cm|in|pt|pc|pi)?$/.exec(v.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] ? n * UNIT_PT[m[2]]! : n / 2
}

/** EMUs (English Metric Units, 914400 per inch) in points. */
export const emuPt = (v: string | null): number | null => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v) / 12700)

export const intOr = (v: string | null): number | null => {
  if (v === null || v === '') return null
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? null : n
}

/** ST_HexColor: "auto" or RRGGBB → "#rrggbb" (null for auto/absent). */
export function hexColor(v: string | null): string | null {
  if (!v || v === 'auto') return null
  return /^[0-9a-fA-F]{6}$/.test(v) ? `#${v.toLowerCase()}` : null
}

export function textOf(el: Element): string {
  return el.textContent ?? ''
}
