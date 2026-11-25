/**
 * Small DOM helpers for SpreadsheetML (ECMA-376 Part 1 §18), shared by the
 * reader and the writers. Elements are matched by namespace + local name,
 * never by prefix.
 */

export const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
export const NS_STRICT = 'http://purl.oclc.org/ooxml/spreadsheetml/main'
export const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
export const NS_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
export const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
export const REL_WORKSHEET = `${REL}worksheet`
export const REL_CHARTSHEET = `${REL}chartsheet`
export const REL_DIALOGSHEET = `${REL}dialogsheet`
export const REL_MACROSHEET = `${REL}xlMacrosheet`
export const REL_SST = `${REL}sharedStrings`
export const REL_STYLES = `${REL}styles`
export const REL_THEME = `${REL}theme`
export const REL_CALC_CHAIN = `${REL}calcChain`

export const CT_WORKSHEET =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml'
export const CT_SST =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'

/** Element children of `el` (optionally only those named `local` in SpreadsheetML main). */
export function kids(el: Element, local?: string, ns: string = NS_MAIN): Element[] {
  const out: Element[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue
    const e = n as Element
    if (local === undefined || (e.localName === local && e.namespaceURI === ns)) out.push(e)
  }
  return out
}

export function kid(el: Element, local: string, ns: string = NS_MAIN): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue
    const e = n as Element
    if (e.localName === local && e.namespaceURI === ns) return e
  }
  return null
}

/** Every descendant named `local` (document order). */
export function all(root: Element | XMLDocument, local: string, ns: string = NS_MAIN): Element[] {
  const list = root.getElementsByTagNameNS(ns, local)
  const out: Element[] = []
  for (let i = 0; i < list.length; i++) out.push(list[i]!)
  return out
}

export const textOf = (el: Element | null): string => (el ? (el.textContent ?? '') : '')

/** A new SpreadsheetML element, written with the prefix the document's root uses for the main namespace. */
export function make(doc: XMLDocument, local: string): Element {
  const root = doc.documentElement!
  const prefix = root.namespaceURI === NS_MAIN ? root.prefix : root.lookupPrefix(NS_MAIN)
  return doc.createElementNS(NS_MAIN, prefix ? `${prefix}:${local}` : local)
}

export function removeAll(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/**
 * Inserts `child` into `parent` before the first existing child whose local
 * name comes later in the schema's sequence `order` (CT_Worksheet,
 * CT_Workbook …), so a new element lands where the schema wants it.
 */
export function insertInOrder(parent: Element, child: Element, order: readonly string[]) {
  const at = order.indexOf(child.localName!)
  for (const k of kids(parent, undefined)) {
    const i = order.indexOf(k.localName!)
    if (i > at) {
      parent.insertBefore(child, k)
      return
    }
  }
  parent.appendChild(child)
}

export function setText(doc: XMLDocument, el: Element, text: string) {
  removeAll(el)
  el.appendChild(doc.createTextNode(text))
  // Leading/trailing spaces and line breaks survive only with xml:space="preserve".
  if (/^\s|\s$|\n/.test(text))
    el.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  else el.removeAttributeNS('http://www.w3.org/XML/1998/namespace', 'space')
}

/** The order of CT_Workbook's children (ECMA-376 Part 1 §18.2.27). */
export const WORKBOOK_ORDER = [
  'fileVersion',
  'fileSharing',
  'workbookPr',
  'workbookProtection',
  'bookViews',
  'sheets',
  'functionGroups',
  'externalReferences',
  'definedNames',
  'calcPr',
  'oleSize',
  'customWorkbookViews',
  'pivotCaches',
  'smartTagPr',
  'smartTagTypes',
  'webPublishing',
  'fileRecoveryPr',
  'webPublishObjects',
  'extLst',
] as const
