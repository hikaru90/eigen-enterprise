import { DOMParser, XMLSerializer, type Node as XmldomNode } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'

/**
 * Open Packaging Conventions (ECMA-376 Part 2): a .docx/.pptx is a ZIP of
 * parts, typed by `[Content_Types].xml` and linked by relationship parts
 * (`_rels/*.rels`). Shared by the Word and PowerPoint formats; it runs the
 * same in the browser and in Node (@xmldom/xmldom for the DOM).
 *
 * Lossless by design: a part nobody changed is written back with its exact
 * original bytes, so whatever a format does not model survives a save.
 */

export const REL_OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT_RELS = 'application/vnd.openxmlformats-package.relationships+xml'
const CT_ZIP_NAME = '[Content_Types].xml'

export class OpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpcError'
  }
}

export type Relationship = {
  id: string
  type: string
  /** The Target attribute as written. */
  target: string
  external: boolean
  /** The absolute part name of an internal target; null for an external one. */
  part: string | null
}

export type OpcPackage = {
  /** Part names ("/word/document.xml"), in package order; `[Content_Types].xml` is not a part. */
  partNames(): string[]
  has(part: string): boolean
  bytes(part: string): Uint8Array
  text(part: string): string
  /** The part parsed (cached); edit it, then `setXml` to save it. */
  xml(part: string): XMLDocument
  setXml(part: string, doc: XMLDocument): void
  /** Writes a part; a new part needs its content type (an Override). */
  setBytes(part: string, bytes: Uint8Array, contentType?: string): void
  remove(part: string): void
  contentType(part: string): string
  /** The relationships of a part, or of the package for "/". */
  relationships(source: string): Relationship[]
  /** Adds a relationship from `source` and returns its new id. */
  addRelationship(source: string, type: string, target: string, opts?: { external?: boolean }): string
  /** The part the package's relationship of `type` points at (e.g. REL_OFFICE_DOCUMENT). */
  mainPart(type: string): string
  toBytes(): Uint8Array
}

const key = (part: string) => part.toLowerCase()
const zipName = (part: string) => part.replace(/^\//, '')

function parseXml(text: string, where: string): XMLDocument {
  const errors: string[] = []
  let doc: XMLDocument
  try {
    doc = new DOMParser({
      onError: (level, msg) => {
        if (level !== 'warning') errors.push(msg)
      },
    }).parseFromString(text, 'application/xml') as unknown as XMLDocument
  } catch (err) {
    // xmldom throws on fatal errors (unclosed tags, unbound prefixes) instead of reporting them.
    throw new OpcError(`${where} is not well-formed XML: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (errors.length > 0 || !doc.documentElement) throw new OpcError(`${where} is not well-formed XML: ${errors[0] ?? 'empty document'}`)
  return doc
}

const serialize = (doc: XMLDocument) => new XMLSerializer().serializeToString(doc as unknown as XmldomNode)

/** The relationships part of `source` ("/" → "/_rels/.rels"; "/a/b.xml" → "/a/_rels/b.xml.rels"). */
export function relsPartOf(source: string): string {
  if (source === '/') return '/_rels/.rels'
  const slash = source.lastIndexOf('/')
  return `${source.slice(0, slash)}/_rels/${source.slice(slash + 1)}.rels`
}

/** Resolves a relative target against the folder of `source` (RFC 3986 path merge). */
export function resolveTarget(source: string, target: string): string {
  const path = target.split(/[?#]/)[0]!
  const base = target.startsWith('/') ? [] : source.split('/').slice(1, -1)
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') base.pop()
    else base.push(seg)
  }
  return `/${base.join('/')}`
}

export function readPackage(bytes: Uint8Array): OpcPackage {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (err) {
    throw new OpcError(`Not a ZIP package: ${err instanceof Error ? err.message : String(err)}`)
  }
  const ctName = Object.keys(entries).find((n) => n.toLowerCase() === CT_ZIP_NAME.toLowerCase())
  if (!ctName) throw new OpcError(`Not an OPC package: it has no ${CT_ZIP_NAME}.`)

  /** Part name → current bytes, package order kept (new parts at the end). */
  const parts = new Map<string, { name: string; bytes: Uint8Array }>()
  for (const [n, b] of Object.entries(entries)) {
    if (n === ctName || n.endsWith('/')) continue
    parts.set(key(`/${n}`), { name: `/${n}`, bytes: b })
  }
  const ctOriginal = entries[ctName]!
  const types = parseXml(strFromU8(ctOriginal), CT_ZIP_NAME)
  let typesDirty = false
  const docs = new Map<string, XMLDocument>()

  function need(part: string) {
    const p = parts.get(key(part))
    if (!p) throw new OpcError(`The package has no part ${part}.`)
    return p
  }

  function contentType(part: string): string {
    need(part)
    const overrides = types.getElementsByTagNameNS(NS_CT, 'Override')
    for (let i = 0; i < overrides.length; i++) {
      const o = overrides[i]!
      if (key(o.getAttribute('PartName') ?? '') === key(part)) return o.getAttribute('ContentType') ?? ''
    }
    const ext = key(part.slice(part.lastIndexOf('.') + 1))
    const defaults = types.getElementsByTagNameNS(NS_CT, 'Default')
    for (let i = 0; i < defaults.length; i++) {
      const d = defaults[i]!
      if (key(d.getAttribute('Extension') ?? '') === ext) return d.getAttribute('ContentType') ?? ''
    }
    throw new OpcError(`${part} has no content type in ${CT_ZIP_NAME}.`)
  }

  function setOverride(part: string, type: string | null) {
    const root = types.documentElement!
    const overrides = types.getElementsByTagNameNS(NS_CT, 'Override')
    for (let i = overrides.length - 1; i >= 0; i--) {
      const o = overrides[i]!
      if (key(o.getAttribute('PartName') ?? '') === key(part)) root.removeChild(o)
    }
    if (type !== null) {
      const o = types.createElementNS(NS_CT, 'Override')
      o.setAttribute('PartName', part)
      o.setAttribute('ContentType', type)
      root.appendChild(o)
    }
    typesDirty = true
  }

  function xml(part: string): XMLDocument {
    const k = key(part)
    const cached = docs.get(k)
    if (cached) return cached
    const doc = parseXml(strFromU8(need(part).bytes), part)
    docs.set(k, doc)
    return doc
  }

  function setBytes(part: string, b: Uint8Array, type?: string) {
    const existing = parts.get(key(part))
    if (!existing && type === undefined) throw new OpcError(`New part ${part} needs its content type.`)
    parts.set(key(part), { name: existing?.name ?? part, bytes: b })
    docs.delete(key(part))
    if (type !== undefined) setOverride(part, type)
  }

  function relationships(source: string): Relationship[] {
    const relsPart = relsPartOf(source)
    if (!parts.has(key(relsPart))) return []
    const els = xml(relsPart).getElementsByTagNameNS(NS_REL, 'Relationship')
    const out: Relationship[] = []
    for (let i = 0; i < els.length; i++) {
      const el = els[i]!
      const target = el.getAttribute('Target') ?? ''
      const external = el.getAttribute('TargetMode') === 'External'
      out.push({ id: el.getAttribute('Id') ?? '', type: el.getAttribute('Type') ?? '', target, external, part: external ? null : resolveTarget(source, target) })
    }
    return out
  }

  return {
    partNames: () => [...parts.values()].map((p) => p.name),
    has: (part) => parts.has(key(part)),
    bytes: (part) => need(part).bytes,
    text: (part) => strFromU8(need(part).bytes),
    xml,
    setXml(part, doc) {
      setBytes(part, strToU8(serialize(doc)))
      docs.set(key(part), doc)
    },
    setBytes,
    remove(part) {
      need(part)
      parts.delete(key(part))
      docs.delete(key(part))
      setOverride(part, null)
    },
    contentType,
    relationships,
    addRelationship(source, type, target, opts = {}) {
      const relsPart = relsPartOf(source)
      if (!parts.has(key(relsPart))) {
        setBytes(relsPart, strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_REL}"/>`), CT_RELS)
      }
      const doc = xml(relsPart)
      const taken = new Set(relationships(source).map((r) => r.id))
      let n = taken.size + 1
      for (const id of taken) {
        const m = /^rId(\d+)$/.exec(id)
        if (m) n = Math.max(n, Number(m[1]) + 1)
      }
      while (taken.has(`rId${n}`)) n++
      const el = doc.createElementNS(NS_REL, 'Relationship')
      el.setAttribute('Id', `rId${n}`)
      el.setAttribute('Type', type)
      el.setAttribute('Target', target)
      if (opts.external) el.setAttribute('TargetMode', 'External')
      doc.documentElement!.appendChild(el)
      this.setXml(relsPart, doc)
      return `rId${n}`
    },
    mainPart(type) {
      const rel = relationships('/').find((r) => r.type === type && !r.external)
      if (!rel?.part) throw new OpcError(`The package has no main part of type ${type}.`)
      return rel.part
    },
    toBytes() {
      const out: Zippable = { [ctName]: typesDirty ? strToU8(serialize(types)) : ctOriginal }
      for (const p of parts.values()) out[zipName(p.name)] = p.bytes
      return zipSync(out)
    },
  }
}
