import { children, NS } from '../xml'

/**
 * Writing WordprocessingML for the editor: elements created with the
 * document's own namespace prefixes, and property children kept in the order
 * the schema sequences require (ECMA-376 Part 1, CT_RPr §17.3.2, CT_PPr
 * §17.3.1, CT_TcPr §17.4) — Word rejects a file whose property children are
 * out of order, so every insertion goes through `setOrdered`.
 */

export const NS_W14 = 'http://schemas.microsoft.com/office/word/2010/wordml'

/** CT_RPr child order. */
export const RPR_ORDER = [
  'rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint',
  'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u',
  'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange',
]

/** CT_PPr child order. */
export const PPR_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd',
  'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi',
  'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
]

/** CT_TcPr child order. */
export const TCPR_ORDER = [
  'cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign',
  'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange',
]

export type Writer = {
  doc: XMLDocument
  /** A new w: element (or of another namespace) with w: attributes. */
  w(local: string, attrs?: Record<string, string>, kids?: Node[]): Element
  el(ns: string, local: string, attrs?: Record<string, string | [string, string]>, kids?: Node[]): Element
  /** A deep copy of a source element in the output document. */
  copy(source: Element): Element
  /** A copy of a source element's own attributes, without its children. */
  shell(source: Element): Element
}

const DEFAULT_PREFIX: Record<string, string> = {
  [NS.w]: 'w',
  [NS.r]: 'r',
  [NS.wp]: 'wp',
  [NS.a]: 'a',
  [NS.pic]: 'pic',
  [NS.xml]: 'xml',
  [NS_W14]: 'w14',
  'http://schemas.microsoft.com/office/word/2012/wordml': 'w15',
  'http://schemas.microsoft.com/office/word/2016/wordml/cid': 'w16cid',
}

/** A writer into `doc`, using the prefixes its root element declares. */
export function writer(doc: XMLDocument): Writer {
  const root = doc.documentElement!
  const prefixes = new Map<string, string>()
  const prefix = (ns: string) => {
    let p = prefixes.get(ns)
    if (p === undefined) {
      p = ns === NS.xml ? 'xml' : (root.lookupPrefix(ns) ?? DEFAULT_PREFIX[ns] ?? 'ns')
      prefixes.set(ns, p)
    }
    return p
  }
  const el: Writer['el'] = (ns, local, attrs = {}, kids = []) => {
    const e = doc.createElementNS(ns, `${prefix(ns)}:${local}`)
    for (const [k, v] of Object.entries(attrs)) {
      // [namespace, value] for an attribute outside the element's namespace; plain names stay unqualified.
      if (Array.isArray(v)) e.setAttributeNS(v[0], `${prefix(v[0])}:${k}`, v[1])
      else if (ns === NS.w) e.setAttributeNS(NS.w, `${prefix(NS.w)}:${k}`, v)
      else e.setAttribute(k, v)
    }
    for (const k of kids) e.appendChild(k)
    return e
  }
  return {
    doc,
    el,
    w: (local, attrs = {}, kids = []) => el(NS.w, local, attrs, kids),
    copy: (source) => doc.importNode(source, true) as Element,
    shell: (source) => doc.importNode(source, false) as Element,
  }
}

/** Sets the w:val attribute (with the document's prefix). */
export function setW(el: Element, local: string, value: string) {
  const prefix = el.lookupPrefix(NS.w) ?? 'w'
  el.setAttributeNS(NS.w, `${prefix}:${local}`, value)
}

/** Removes every w:`local` child. */
export function removeChildren(parent: Element, local: string) {
  for (const c of children(parent)) if (c.namespaceURI === NS.w && c.localName === local) parent.removeChild(c)
}

/**
 * Puts `child` (a w: element) into `parent` where the schema order places
 * it, replacing an existing child of the same name. Children the order does
 * not list (extensions) keep their place.
 */
export function setOrdered(parent: Element, child: Element, order: readonly string[]) {
  removeChildren(parent, child.localName!)
  const rank = order.indexOf(child.localName!)
  if (rank < 0) throw new Error(`setOrdered: ${child.localName} is not in the property order`)
  for (const c of children(parent)) {
    if (c.namespaceURI !== NS.w) continue
    const r = order.indexOf(c.localName!)
    if (r > rank) {
      parent.insertBefore(child, c)
      return
    }
  }
  parent.appendChild(child)
}

/** The first w:`local` child. */
export function wChild(parent: Element | null, local: string): Element | null {
  if (!parent) return null
  for (const c of children(parent)) if (c.namespaceURI === NS.w && c.localName === local) return c
  return null
}

/** Whether text needs xml:space="preserve" to keep its spaces (§17.3.3.31: leading, trailing or repeated whitespace). */
export const needsPreserve = (text: string) => /^\s|\s$|\s\s/.test(text)
