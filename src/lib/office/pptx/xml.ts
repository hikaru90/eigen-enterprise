/**
 * Small DOM helpers for PresentationML/DrawingML parts (ECMA-376 Part 1),
 * namespace-aware. Elements are matched by namespace URI + local name, never
 * by prefix, since producers pick their own prefixes.
 */

export const NS = {
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
} as const

/** ISO/IEC 29500 Strict namespaces: a different vocabulary we do not read yet. */
export const NS_STRICT_P = 'http://purl.oclc.org/ooxml/presentationml/main'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
export const REL_TYPE = {
  slide: `${REL}slide`,
  slideLayout: `${REL}slideLayout`,
  slideMaster: `${REL}slideMaster`,
  theme: `${REL}theme`,
  notesSlide: `${REL}notesSlide`,
  image: `${REL}image`,
  hyperlink: `${REL}hyperlink`,
  tableStyles: `${REL}tableStyles`,
} as const

/** Namespaces whose markup this reader understands (Markup Compatibility, ECMA-376 Part 3 §10.2). */
const UNDERSTOOD = new Set<string>([NS.a, NS.p, NS.r, NS.mc])

export function isEl(n: Node | null | undefined): n is Element {
  return !!n && n.nodeType === 1
}

/**
 * The element children of `el`, with `mc:AlternateContent` replaced by the
 * branch this reader understands: the first `mc:Choice` whose `Requires`
 * namespaces are all understood, else `mc:Fallback` (Part 3 §10.2.1).
 */
export function kids(el: Element | null | undefined): Element[] {
  const out: Element[] = []
  if (!el) return out
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (!isEl(n)) continue
    if (n.namespaceURI === NS.mc && n.localName === 'AlternateContent') out.push(...kids(chooseAlternate(n)))
    else out.push(n)
  }
  return out
}

function chooseAlternate(ac: Element): Element {
  let fallback: Element | null = null
  for (let n = ac.firstChild; n; n = n.nextSibling) {
    if (!isEl(n) || n.namespaceURI !== NS.mc) continue
    if (n.localName === 'Choice') {
      const requires = (n.getAttribute('Requires') ?? '').split(/\s+/).filter(Boolean)
      const ok = requires.every((prefix) => {
        const uri = n.lookupNamespaceURI(prefix)
        return uri !== null && UNDERSTOOD.has(uri)
      })
      if (ok) return n
    } else if (n.localName === 'Fallback') fallback = n
  }
  // Nothing understood and no fallback: an empty branch (the content is for a newer reader).
  return fallback ?? ac.ownerDocument!.createElementNS(NS.mc, 'Fallback')
}

export function child(el: Element | null | undefined, ns: string, name: string): Element | null {
  if (!el) return null
  for (const k of kids(el)) if (k.namespaceURI === ns && k.localName === name) return k
  return null
}

export function children(el: Element | null | undefined, ns: string, name: string): Element[] {
  if (!el) return []
  return kids(el).filter((k) => k.namespaceURI === ns && k.localName === name)
}

/** Child in the DrawingML namespace. */
export const a = (el: Element | null | undefined, name: string) => child(el, NS.a, name)
/** Child in the PresentationML namespace. */
export const p = (el: Element | null | undefined, name: string) => child(el, NS.p, name)

/** Follows a path of DrawingML/PresentationML children, "p:nvSpPr/p:nvPr/p:ph". */
export function path(el: Element | null | undefined, spec: string): Element | null {
  let cur: Element | null = el ?? null
  for (const step of spec.split('/')) {
    if (!cur) return null
    const [prefix, name] = step.split(':') as [keyof typeof NS, string]
    cur = child(cur, NS[prefix], name)
  }
  return cur
}

export function attr(el: Element | null | undefined, name: string): string | null {
  if (!el || !el.hasAttribute(name)) return null
  return el.getAttribute(name)
}

export function intAttr(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name)
  if (v === null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** xsd:boolean ("1"/"true"/"0"/"false"); null when absent. */
export function boolAttr(el: Element | null | undefined, name: string): boolean | null {
  const v = attr(el, name)
  if (v === null) return null
  return v === '1' || v === 'true' || v === 'on'
}

/** ST_Percentage / ST_PositivePercentage: "50000" or (transitional writers) "50%". In 1/100000. */
export function pctAttr(el: Element | null | undefined, name: string): number | null {
  const v = attr(el, name)
  if (v === null) return null
  if (v.endsWith('%')) {
    const n = Number(v.slice(0, -1))
    return Number.isFinite(n) ? n * 1000 : null
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** The r:id / r:embed relationship attribute. */
export function relAttr(el: Element | null | undefined, name: string): string | null {
  if (!el) return null
  const v = el.getAttributeNS(NS.r, name)
  return v === null || v === '' ? null : v
}
