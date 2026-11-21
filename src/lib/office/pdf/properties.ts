import type { PDFDocument } from 'pdf-lib'
/**
 * Document properties (plan/phase-office-files.md P3): the document
 * information dictionary (ISO 32000-2 §14.3.3: Title, Author, Subject,
 * Keywords) and the XMP metadata stream (§14.3.2) kept in step with it —
 * dc:title, dc:creator, dc:description, dc:subject + pdf:Keywords, and the
 * modify date. PDF 2.0 readers take XMP first, so both are written.
 */
import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from '@xmldom/xmldom'
import {
  decodePDFRawStream,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib/dist/pdf-lib.esm.js'
import { parsePdfDate, PdfEditError } from './annotate-model'

export type PdfProperties = {
  title: string
  author: string
  subject: string
  keywords: string
  /** Read-only: the application that made it, the one that wrote the PDF, and the dates. */
  creator: string
  producer: string
  created: string | null
  modified: string | null
}

export type PropertiesPatch = Partial<
  Pick<PdfProperties, 'title' | 'author' | 'subject' | 'keywords'>
>
export const EDITABLE_PROPERTIES = ['title', 'author', 'subject', 'keywords'] as const

const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  xml: 'http://www.w3.org/XML/1998/namespace',
} as const
type Prefix = keyof typeof NS

function infoDict(doc: PDFDocument): PDFDict | undefined {
  const info = doc.context.trailerInfo.Info
  return info ? doc.context.lookupMaybe(info, PDFDict) : undefined
}

function infoText(doc: PDFDocument, key: string): string | null {
  const v = infoDict(doc)?.lookup(PDFName.of(key))
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : null
}

// --- XMP --------------------------------------------------------------------

function metadataRef(doc: PDFDocument): PDFRef | null {
  const v = doc.catalog.get(PDFName.of('Metadata'))
  return v instanceof PDFRef ? v : null
}

function readXmp(doc: PDFDocument): XmlDocument | null {
  const ref = metadataRef(doc)
  const stream = ref ? doc.context.lookupMaybe(ref, PDFStream) : undefined
  if (!stream) return null
  const bytes =
    stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents()
  const xml = new TextDecoder('utf-8').decode(bytes)
  try {
    const parsed = new DOMParser().parseFromString(xml, 'text/xml')
    return parsed.getElementsByTagNameNS(NS.rdf, 'RDF').length ? parsed : null
  } catch (err) {
    throw new PdfEditError(
      `The file’s XMP metadata can’t be read: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function descriptions(xmp: XmlDocument): XmlElement[] {
  return Array.from(xmp.getElementsByTagNameNS(NS.rdf, 'Description'))
}

/** A simple or array property's text (x-default first for alternatives). */
function xmpText(xmp: XmlDocument, prefix: Prefix, local: string): string | null {
  for (const d of descriptions(xmp)) {
    if (d.hasAttributeNS(NS[prefix], local)) return d.getAttributeNS(NS[prefix], local)
    const el = Array.from(d.getElementsByTagNameNS(NS[prefix], local))[0]
    if (!el) continue
    const items = Array.from(el.getElementsByTagNameNS(NS.rdf, 'li'))
    if (items.length === 0) return el.textContent ?? ''
    const preferred =
      items.find((li) => li.getAttributeNS(NS.xml, 'lang') === 'x-default') ?? items[0]!
    return local === 'creator' || local === 'subject'
      ? items.map((li) => li.textContent ?? '').join(', ')
      : (preferred.textContent ?? '')
  }
  return null
}

type XmpKind = 'simple' | 'alt' | 'seq' | 'bag'

function setXmp(xmp: XmlDocument, prefix: Prefix, local: string, kind: XmpKind, values: string[]) {
  const all = descriptions(xmp)
  for (const d of all) {
    if (d.hasAttributeNS(NS[prefix], local)) d.removeAttributeNS(NS[prefix], local)
    for (const el of Array.from(d.getElementsByTagNameNS(NS[prefix], local))) d.removeChild(el)
  }
  const clean = values.filter((v) => v !== '')
  if (clean.length === 0) return
  const host = all[0]!
  if (!host.lookupNamespaceURI(prefix) && !host.hasAttribute(`xmlns:${prefix}`))
    host.setAttribute(`xmlns:${prefix}`, NS[prefix])
  const el = xmp.createElementNS(NS[prefix], `${prefix}:${local}`)
  if (kind === 'simple') el.appendChild(xmp.createTextNode(clean[0]!))
  else {
    const list = xmp.createElementNS(
      NS.rdf,
      `rdf:${kind === 'alt' ? 'Alt' : kind === 'seq' ? 'Seq' : 'Bag'}`,
    )
    for (const v of clean) {
      const li = xmp.createElementNS(NS.rdf, 'rdf:li')
      if (kind === 'alt') li.setAttributeNS(NS.xml, 'xml:lang', 'x-default')
      li.appendChild(xmp.createTextNode(v))
      list.appendChild(li)
    }
    el.appendChild(list)
  }
  host.appendChild(el)
}

function newXmp(): XmlDocument {
  const xml = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="${NS.x}"><rdf:RDF xmlns:rdf="${NS.rdf}"><rdf:Description rdf:about="" xmlns:dc="${NS.dc}" xmlns:pdf="${NS.pdf}" xmlns:xmp="${NS.xmp}"/></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`
  return new DOMParser().parseFromString(xml, 'text/xml')
}

function writeXmp(doc: PDFDocument, xmp: XmlDocument) {
  const xml = new XMLSerializer().serializeToString(xmp)
  const stream = doc.context.stream(new TextEncoder().encode(xml), {
    Type: 'Metadata',
    Subtype: 'XML',
  })
  const ref = metadataRef(doc)
  if (ref) doc.context.assign(ref, stream)
  else doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream))
}

/** Keyword lists are written as one string in Info and one entry per keyword in dc:subject. */
export function keywordList(keywords: string): string[] {
  return keywords
    .split(/[,;]/)
    .map((k) => k.trim())
    .filter(Boolean)
}

// --- reading and writing ------------------------------------------------------

export function readProperties(doc: PDFDocument): PdfProperties {
  const xmp = readXmp(doc)
  const pick = (info: string, prefix: Prefix, local: string) =>
    infoText(doc, info) ?? (xmp ? xmpText(xmp, prefix, local) : null) ?? ''
  return {
    title: pick('Title', 'dc', 'title'),
    author: pick('Author', 'dc', 'creator'),
    subject: pick('Subject', 'dc', 'description'),
    keywords: pick('Keywords', 'pdf', 'Keywords'),
    creator: infoText(doc, 'Creator') ?? '',
    producer: infoText(doc, 'Producer') ?? '',
    created: parsePdfDate(infoText(doc, 'CreationDate')),
    modified: parsePdfDate(infoText(doc, 'ModDate')),
  }
}

/** The modify date in Info and, when the file has XMP, there too. */
export function touchModified(doc: PDFDocument, now: Date) {
  doc.setModificationDate(now)
  const xmp = readXmp(doc)
  if (!xmp) return
  setXmp(xmp, 'xmp', 'ModifyDate', 'simple', [now.toISOString()])
  setXmp(xmp, 'xmp', 'MetadataDate', 'simple', [now.toISOString()])
  writeXmp(doc, xmp)
}

export function setProperties(doc: PDFDocument, patch: PropertiesPatch, now: Date) {
  for (const key of Object.keys(patch))
    if (!(EDITABLE_PROPERTIES as readonly string[]).includes(key))
      throw new PdfEditError(
        `“${key}” is not a property that can be set (${EDITABLE_PROPERTIES.join(', ')}).`,
      )
  const current = readProperties(doc)
  const next = { ...current, ...patch }
  const info = (key: 'Title' | 'Author' | 'Subject' | 'Keywords', value: string) => {
    if (value === '') infoDict(doc)?.delete(PDFName.of(key))
    else if (key === 'Title') doc.setTitle(value)
    else if (key === 'Author') doc.setAuthor(value)
    else if (key === 'Subject') doc.setSubject(value)
    else doc.setKeywords([value])
  }
  if (patch.title !== undefined) info('Title', next.title)
  if (patch.author !== undefined) info('Author', next.author)
  if (patch.subject !== undefined) info('Subject', next.subject)
  if (patch.keywords !== undefined) info('Keywords', next.keywords)
  const xmp = readXmp(doc) ?? newXmp()
  setXmp(xmp, 'dc', 'title', 'alt', [next.title])
  setXmp(xmp, 'dc', 'creator', 'seq', [next.author])
  setXmp(xmp, 'dc', 'description', 'alt', [next.subject])
  setXmp(xmp, 'dc', 'subject', 'bag', keywordList(next.keywords))
  setXmp(xmp, 'pdf', 'Keywords', 'simple', [next.keywords])
  writeXmp(doc, xmp)
  touchModified(doc, now)
}
