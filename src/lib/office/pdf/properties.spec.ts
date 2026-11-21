import {
  decodePDFRawStream,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib/dist/pdf-lib.esm.js'
import { describe, expect, it } from 'vitest'
import { applyPdfEdits, readPdfContents } from './edit'
import { makePdf } from './fixtures'

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjs: Promise<PdfJs> | null = null
function lib(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker =
      await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
    return import('pdfjs-dist/legacy/build/pdf.mjs')
  })()
  return pdfjs
}

/** What pdf.js reads: the Info dictionary and the XMP metadata. */
async function metadataSeen(bytes: Uint8Array) {
  const { getDocument } = await lib()
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  try {
    const { info, metadata } = await doc.getMetadata()
    return {
      info: info as Record<string, unknown>,
      xmp: metadata ? Object.fromEntries(metadata) : null,
    }
  } finally {
    await task.destroy()
  }
}

async function xmpOf(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  const ref = doc.catalog.get(PDFName.of('Metadata')) as PDFRef
  const stream = doc.context.lookup(ref) as PDFRawStream
  return new TextDecoder().decode(decodePDFRawStream(stream).decode())
}

const ctx = { author: 'Alice', now: new Date('2026-11-21T10:00:00Z') }

describe('PDF document properties', () => {
  it('reads Info', async () => {
    const { properties } = await readPdfContents({
      bytes: await makePdf([{ lines: ['x'] }], { title: 'Annual report' }),
    })
    expect(properties).toMatchObject({
      title: 'Annual report',
      author: '',
      subject: '',
      keywords: '',
    })
    expect(properties.producer).toContain('pdf-lib')
  })

  it('writes Info and XMP in step (a new XMP packet when the file had none)', async () => {
    const out = await applyPdfEdits(
      { bytes: await makePdf([{ lines: ['x'] }], { title: 'Old' }) },
      {
        properties: {
          title: 'Jahresbericht 2026',
          author: 'Alice Example',
          subject: 'Results',
          keywords: 'finance, annual; 2026',
        },
      },
      ctx,
    )
    const { properties } = await readPdfContents({ bytes: out.bytes })
    expect(properties).toMatchObject({
      title: 'Jahresbericht 2026',
      author: 'Alice Example',
      subject: 'Results',
      keywords: 'finance, annual; 2026',
      modified: '2026-11-21T10:00:00.000Z',
    })
    const seen = await metadataSeen(out.bytes)
    expect(seen.info).toMatchObject({
      Title: 'Jahresbericht 2026',
      Author: 'Alice Example',
      Subject: 'Results',
      Keywords: 'finance, annual; 2026',
    })
    expect(seen.xmp).toMatchObject({
      'dc:title': 'Jahresbericht 2026',
      'dc:creator': ['Alice Example'],
      'dc:description': 'Results',
      'dc:subject': ['finance', 'annual', '2026'],
      'pdf:keywords': 'finance, annual; 2026',
      'xmp:modifydate': '2026-11-21T10:00:00.000Z',
    })
  })

  it('updates the file’s own XMP, keeping what it doesn’t set, and clears emptied properties', async () => {
    const first = await applyPdfEdits(
      { bytes: await makePdf([{ lines: ['x'] }]) },
      { properties: { title: 'T', author: 'A' } },
      ctx,
    )
    // Someone else's property in the packet stays.
    const doc = await PDFDocument.load(first.bytes)
    const xml = (await xmpOf(first.bytes)).replace(
      '</rdf:RDF>',
      '<rdf:Description rdf:about="" xmlns:my="urn:my#"><my:keep>yes</my:keep></rdf:Description></rdf:RDF>',
    )
    doc.context.assign(
      doc.catalog.get(PDFName.of('Metadata')) as PDFRef,
      doc.context.stream(xml, { Type: 'Metadata', Subtype: 'XML' }),
    )
    const marked = await doc.save()
    const later = new Date('2026-11-22T08:00:00Z')
    const second = await applyPdfEdits(
      { bytes: marked },
      { properties: { title: '', subject: 'S' } },
      { ...ctx, now: later },
    )
    const after = await xmpOf(second.bytes)
    expect(after).toContain('<my:keep>yes</my:keep>')
    expect(after).not.toContain('dc:title')
    const { properties } = await readPdfContents({ bytes: second.bytes })
    expect(properties).toMatchObject({
      title: '',
      author: 'A',
      subject: 'S',
      modified: '2026-11-22T08:00:00.000Z',
    })
    expect((await metadataSeen(second.bytes)).info.Title).toBeUndefined()
  })

  it('refuses a property it doesn’t edit', async () => {
    await expect(
      applyPdfEdits(
        { bytes: await makePdf([{ lines: ['x'] }]) },
        { properties: { producer: 'me' } as never },
        ctx,
      ),
    ).rejects.toThrow('“producer” is not a property that can be set')
  })

  it('every other save moves the modify date, in Info and XMP alike', async () => {
    const first = await applyPdfEdits(
      { bytes: await makePdf([{ lines: ['x'] }]) },
      { properties: { title: 'T' } },
      ctx,
    )
    const later = new Date('2026-12-01T00:00:00Z')
    const noted = await applyPdfEdits(
      { bytes: first.bytes },
      {
        annotations: [
          {
            op: 'add',
            key: 'new:n',
            annotation: {
              page: 0,
              shape: { kind: 'Text', at: [100, 700] },
              color: [1, 1, 0],
              opacity: 1,
              contents: 'hi',
            },
          },
        ],
      },
      { ...ctx, now: later },
    )
    expect((await readPdfContents({ bytes: noted.bytes })).properties.modified).toBe(
      later.toISOString(),
    )
    expect(await xmpOf(noted.bytes)).toContain('2026-12-01T00:00:00.000Z')
  })
})
