/**
 * PDFs made in tests (never downloaded samples): pdf-lib for ordinary files,
 * a small hand writer for an encrypted one (pdf-lib can't encrypt). Shared
 * by the Node unit tests and the browser component tests, so no Node APIs.
 * pdf-lib comes from its self-contained ES bundle: the browser test runner
 * doesn't pre-bundle the CommonJS deflate library its modules import.
 */
import type { PDFRef } from 'pdf-lib'
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  degrees,
} from 'pdf-lib/dist/pdf-lib.esm.js'

export type FixturePage = {
  /** Lines of text, top to bottom; an empty string leaves a paragraph gap. */
  lines: string[]
  size?: [number, number]
  rotate?: 0 | 90 | 180 | 270
}

export type FixtureOptions = {
  title?: string
  /** /PageLabels number tree entries: [first page index, style ('D', 'r', 'R', 'a', 'A' or none), prefix?, start?]. */
  labels?: Array<{
    from: number
    style?: 'D' | 'r' | 'R' | 'a' | 'A'
    prefix?: string
    start?: number
  }>
  /** Bookmarks: title → 0-based page index; `children` nest. */
  outline?: FixtureBookmark[]
  /** Link annotations: on page `from`, going to page `to` (0-based); `named`: through a named destination. */
  links?: Array<{ from: number; to: number; named?: string }>
  /** Text form fields, each with one widget on `page` (0-based). */
  fields?: Array<{ name: string; page: number; value?: string }>
  /** Sticky notes (text annotations) on pages. */
  notes?: Array<{ page: number; text: string }>
}

export type FixtureBookmark = { title: string; page: number; children?: FixtureBookmark[] }

const LINE = 16
const SIZE = 12
const MARGIN = 72

/** A PDF with the given pages of text (Helvetica 12pt, 16pt leading, 72pt margins). */
export async function makePdf(
  pages: FixturePage[],
  opts: FixtureOptions = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  if (opts.title) doc.setTitle(opts.title)
  for (const p of pages) {
    const page = doc.addPage(p.size ?? [612, 792])
    if (p.rotate) page.setRotation(degrees(p.rotate))
    let y = page.getHeight() - MARGIN
    for (const line of p.lines) {
      if (line) page.drawText(line, { x: MARGIN, y, size: SIZE, font })
      y -= LINE
    }
  }
  if (opts.labels) {
    const nums: unknown[] = []
    for (const l of opts.labels) {
      const dict: Record<string, unknown> = {}
      if (l.style) dict.S = PDFName.of(l.style)
      if (l.prefix) dict.P = PDFString.of(l.prefix)
      if (l.start !== undefined) dict.St = PDFNumber.of(l.start)
      nums.push(PDFNumber.of(l.from), doc.context.obj(dict as never))
    }
    doc.catalog.set(PDFName.of('PageLabels'), doc.context.obj({ Nums: nums as never }))
  }
  const refs = doc.getPages().map((p) => p.ref)
  const named: unknown[] = []
  for (const l of opts.links ?? []) {
    const to = refs[l.to]
    const from = doc.getPages()[l.from]
    if (!to || !from)
      throw new Error(`The link ${l.from} → ${l.to} names a page the fixture lacks.`)
    const dest = [to, PDFName.of('Fit')]
    if (l.named) named.push(PDFString.of(l.named), doc.context.obj(dest as never))
    const annot = doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [MARGIN, 40, MARGIN + 100, 56],
        Border: [0, 0, 0],
        Dest: l.named ? PDFString.of(l.named) : (dest as never),
      } as never),
    )
    from.node.addAnnot(annot)
  }
  if (named.length)
    doc.catalog.set(
      PDFName.of('Names'),
      doc.context.obj({ Dests: doc.context.obj({ Names: named as never }) } as never),
    )
  for (const n of opts.notes ?? []) {
    const page = doc.getPages()[n.page]
    if (!page)
      throw new Error(`The note “${n.text}” names page ${n.page}, which the fixture lacks.`)
    page.node.addAnnot(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Text',
          Rect: [400, 700, 420, 720],
          Contents: PDFString.of(n.text),
          P: page.ref,
        } as never),
      ),
    )
  }
  if (opts.fields?.length) {
    const form = doc.getForm()
    for (const f of opts.fields) {
      const page = doc.getPages()[f.page]
      if (!page)
        throw new Error(`The field “${f.name}” names page ${f.page}, which the fixture lacks.`)
      const field = form.createTextField(f.name)
      if (f.value) field.setText(f.value)
      field.addToPage(page, { x: MARGIN, y: 100, width: 200, height: 20, font })
    }
  }
  if (opts.outline?.length) {
    const root = doc.context.nextRef()
    const count = writeOutline(doc, root, opts.outline, refs)
    doc.context.assign(
      root,
      doc.context.obj({
        Type: 'Outlines',
        First: count.first,
        Last: count.last,
        Count: count.total,
      }),
    )
    doc.catalog.set(PDFName.of('Outlines'), root)
  }
  return doc.save({ useObjectStreams: false })
}

function writeOutline(
  doc: PDFDocument,
  parent: PDFRef,
  items: FixtureBookmark[],
  pageRefs: PDFRef[],
): { first: PDFRef; last: PDFRef; total: number } {
  const refs = items.map(() => doc.context.nextRef())
  let total = 0
  items.forEach((item, i) => {
    const page = pageRefs[item.page]
    if (!page)
      throw new Error(
        `Bookmark "${item.title}" points at page ${item.page}, which the fixture lacks.`,
      )
    const dict: Record<string, unknown> = {
      Title: PDFString.of(item.title),
      Parent: parent,
      Dest: [page, PDFName.of('XYZ'), null, 792, null],
    }
    if (i > 0) dict.Prev = refs[i - 1]
    if (i < items.length - 1) dict.Next = refs[i + 1]
    total += 1
    if (item.children?.length) {
      const kids = writeOutline(doc, refs[i]!, item.children, pageRefs)
      dict.First = kids.first
      dict.Last = kids.last
      dict.Count = kids.total
      total += kids.total
    }
    doc.context.assign(refs[i]!, doc.context.obj(dict as never))
  })
  return { first: refs[0]!, last: refs[refs.length - 1]!, total }
}

/** Bytes that start like a PDF and then aren't one. */
export function brokenPdf(): Uint8Array {
  return new TextEncoder().encode(
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 9 0 R\nthis is not a PDF at all\n',
  )
}

// ---------------------------------------------------------------------------
// Encrypted fixture: the standard security handler, revision 2 (RC4, 40-bit
// key), ISO 32000-2 §7.6.4 algorithms 1-4. Tiny on purpose; it only has to
// make pdf.js ask for a password.

const PAD = [
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]

function padded(password: string): number[] {
  const bytes = [...new TextEncoder().encode(password)].slice(0, 32)
  return [...bytes, ...PAD.slice(0, 32 - bytes.length)]
}

function rc4(key: number[], data: number[]): number[] {
  const s = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }
  const out: number[] = []
  let a = 0
  let b = 0
  for (const byte of data) {
    a = (a + 1) & 255
    b = (b + s[a]!) & 255
    ;[s[a], s[b]] = [s[b]!, s[a]!]
    out.push(byte ^ s[(s[a]! + s[b]!) & 255]!)
  }
  return out
}

/** MD5 (RFC 1321) — the security handler's hash; WebCrypto has none. */
function md5(input: number[]): number[] {
  const r = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ]
  const k = Array.from(
    { length: 64 },
    (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
  )
  const msg = [...input, 0x80]
  while (msg.length % 64 !== 56) msg.push(0)
  const bits = input.length * 8
  for (let i = 0; i < 8; i++) msg.push(i < 4 ? (bits >>> (8 * i)) & 255 : 0)
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  for (let off = 0; off < msg.length; off += 64) {
    const w = Array.from(
      { length: 16 },
      (_, i) =>
        msg[off + 4 * i]! |
        (msg[off + 4 * i + 1]! << 8) |
        (msg[off + 4 * i + 2]! << 16) |
        (msg[off + 4 * i + 3]! << 24),
    )
    let [a, b, c, d] = [h0, h1, h2, h3]
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) [f, g] = [(b & c) | (~b & d), i]
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16]
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16]
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16]
      const t = d
      d = c
      c = b
      const sum = (a + f + k[i]! + w[g]!) | 0
      b = (b + ((sum << r[i]!) | (sum >>> (32 - r[i]!)))) | 0
      a = t
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
  }
  return [h0, h1, h2, h3].flatMap((h) => [
    h & 255,
    (h >>> 8) & 255,
    (h >>> 16) & 255,
    (h >>> 24) & 255,
  ])
}

/** A one-page PDF that opens only with `password` (user password; RC4 40-bit). */
export function encryptedPdf(password: string, text: string): Uint8Array {
  const id = Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 255)
  const perms = -4 // all permissions (bits 3+ set), ISO 32000-2 Table 22
  const o = rc4(md5(padded('owner-' + password)).slice(0, 5), padded(password))
  const p = [perms & 255, (perms >> 8) & 255, (perms >> 16) & 255, (perms >> 24) & 255]
  const key = md5([...padded(password), ...o, ...p, ...id]).slice(0, 5)
  const u = rc4(key, PAD)
  const objKey = (num: number) =>
    md5([...key, num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]).slice(0, 10)
  const hex = (bytes: number[]) => `<${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}>`
  const ascii = (s: string) => [...new TextEncoder().encode(s)]

  const content = ascii(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)
  const stream = rc4(objKey(4), content)
  const objects: number[][] = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    [...ascii(`<< /Length ${stream.length} >>\nstream\n`), ...stream, ...ascii('\nendstream')],
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    ascii(`<< /Filter /Standard /V 1 /R 2 /O ${hex(o)} /U ${hex(u)} /P ${perms} >>`),
  ]
  const out = ascii('%PDF-1.4\n')
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out.push(...ascii(`${i + 1} 0 obj\n`), ...body, ...ascii('\nendobj\n'))
  })
  const xref = out.length
  out.push(...ascii(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`))
  for (const off of offsets) out.push(...ascii(`${String(off).padStart(10, '0')} 00000 n \n`))
  out.push(
    ...ascii(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [${hex(id)} ${hex(id)}] >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  )
  return new Uint8Array(out)
}
