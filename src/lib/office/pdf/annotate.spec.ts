import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib/dist/pdf-lib.esm.js'
import { describe, expect, it } from 'vitest'
import {
  foldEdits,
  quadOf,
  threadsOf,
  type AnnotationEdit,
  type PdfAnnotation,
} from './annotate-model'
import { applyPdfEdits, readPdfContents, PdfEditError } from './edit'
import { encryptedPdf, makePdf } from './fixtures'

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

type Seen = {
  id: string
  page: number
  subtype: string
  color: number[] | null
  opacity: number
  author: string
  contents: string
  hasAppearance: boolean
  inReplyTo: string | null
  quads?: number
  inkPaths?: number
  line?: number[]
  ends?: string[]
}

/** What pdf.js (an independent reader) sees of a file's annotations. */
async function seenByPdfJs(bytes: Uint8Array): Promise<Seen[]> {
  const { getDocument } = await lib()
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true })
  const doc = await task.promise
  const out: Seen[] = []
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      for (const a of (await page.getAnnotations()) as Array<Record<string, unknown>>) {
        if (a.subtype === 'Popup') continue
        const color = a.color as Uint8ClampedArray | null
        out.push({
          id: a.id as string,
          page: n - 1,
          subtype: a.subtype as string,
          color: color ? [...color] : null,
          opacity: a.opacity as number,
          author: (a.titleObj as { str: string }).str,
          contents: (a.contentsObj as { str: string }).str,
          hasAppearance: a.hasAppearance as boolean,
          inReplyTo: (a.inReplyTo as string | undefined) ?? null,
          ...(a.quadPoints ? { quads: (a.quadPoints as Float32Array).length / 8 } : {}),
          ...(a.inkLists ? { inkPaths: (a.inkLists as unknown[]).length } : {}),
          ...(a.lineCoordinates ? { line: [...(a.lineCoordinates as number[])] } : {}),
          ...(a.lineEndings ? { ends: a.lineEndings as string[] } : {}),
        })
      }
    }
  } finally {
    await task.destroy()
  }
  return out
}

const ctx = { author: 'Alice Example', now: new Date('2026-11-21T10:00:00Z') }
const red: [number, number, number] = [1, 0, 0]
const yellow: [number, number, number] = [1, 0.85, 0]

function pageStream(doc: PDFDocument, i: number): Uint8Array {
  const contents = doc.getPages()[i]!.node.Contents()
  const stream = contents instanceof PDFArray ? doc.context.lookup(contents.get(0)) : contents
  return (stream as PDFRawStream).contents
}

const everyKind: AnnotationEdit[] = [
  {
    op: 'add',
    key: 'new:hl',
    annotation: {
      page: 0,
      shape: {
        kind: 'Highlight',
        quads: [quadOf([72, 700, 200, 714]), quadOf([72, 684, 160, 698])],
      },
      color: yellow,
      opacity: 0.5,
      contents: 'Check this',
    },
  },
  {
    op: 'add',
    key: 'new:ul',
    annotation: {
      page: 0,
      shape: { kind: 'Underline', quads: [quadOf([72, 668, 200, 682])] },
      color: red,
      opacity: 1,
    },
  },
  {
    op: 'add',
    key: 'new:so',
    annotation: {
      page: 0,
      shape: { kind: 'StrikeOut', quads: [quadOf([72, 652, 200, 666])] },
      color: red,
      opacity: 1,
    },
  },
  {
    op: 'add',
    key: 'new:sq',
    annotation: {
      page: 0,
      shape: { kind: 'Squiggly', quads: [quadOf([72, 636, 200, 650])] },
      color: red,
      opacity: 1,
    },
  },
  {
    op: 'add',
    key: 'new:note',
    annotation: {
      page: 0,
      shape: { kind: 'Text', at: [500, 740] },
      color: yellow,
      opacity: 1,
      contents: 'Für später — 確認',
    },
  },
  {
    op: 'add',
    key: 'new:ink',
    annotation: {
      page: 0,
      shape: {
        kind: 'Ink',
        paths: [
          [100, 400, 120, 420, 140, 400],
          [150, 400, 170, 430],
        ],
        width: 2,
      },
      color: [0, 0, 1],
      opacity: 0.8,
    },
  },
  {
    op: 'add',
    key: 'new:box',
    annotation: {
      page: 0,
      shape: { kind: 'FreeText', rect: [300, 300, 480, 360], fontSize: 12 },
      color: [0, 0, 0],
      opacity: 1,
      contents: 'A text box that wraps onto a second line',
    },
  },
  {
    op: 'add',
    key: 'new:rect',
    annotation: {
      page: 0,
      shape: { kind: 'Square', rect: [72, 200, 200, 260], width: 2, fill: null },
      color: red,
      opacity: 1,
    },
  },
  {
    op: 'add',
    key: 'new:oval',
    annotation: {
      page: 0,
      shape: { kind: 'Circle', rect: [220, 200, 300, 260], width: 1, fill: yellow },
      color: red,
      opacity: 1,
    },
  },
  {
    op: 'add',
    key: 'new:arrow',
    annotation: {
      page: 0,
      shape: { kind: 'Line', line: [320, 220, 450, 260], width: 1.5, ends: ['None', 'OpenArrow'] },
      color: red,
      opacity: 1,
    },
  },
  { op: 'reply', key: 'new:re', to: 'new:note', contents: 'Agreed' },
  { op: 'review', id: 'new:note', state: 'Completed' },
]

describe('PDF annotations', () => {
  it('writes every kind as a real annotation with an appearance, which pdf.js reads back the same', async () => {
    const before = await makePdf([{ lines: ['First page text'] }, { lines: ['Second page'] }])
    const out = await applyPdfEdits({ bytes: before }, { annotations: everyKind }, ctx)
    const seen = await seenByPdfJs(out.bytes)
    const byKey = (k: string) => seen.find((s) => s.id === out.created[k])!
    expect(Object.keys(out.created)).toHaveLength(11)
    // The state annotation is hidden and is not listed by pdf.js as a separate display item.
    expect(
      seen.filter((s) => s.inReplyTo === out.created['new:note']).map((s) => s.contents),
    ).toContain('Agreed')
    expect(byKey('new:hl')).toMatchObject({
      subtype: 'Highlight',
      color: [255, 217, 0],
      opacity: 0.5,
      author: 'Alice Example',
      contents: 'Check this',
      hasAppearance: true,
      quads: 2,
    })
    for (const [k, subtype] of [
      ['new:ul', 'Underline'],
      ['new:so', 'StrikeOut'],
      ['new:sq', 'Squiggly'],
    ] as const)
      expect(byKey(k)).toMatchObject({ subtype, color: [255, 0, 0], hasAppearance: true, quads: 1 })
    expect(byKey('new:note')).toMatchObject({
      subtype: 'Text',
      contents: 'Für später — 確認',
      hasAppearance: true,
    })
    expect(byKey('new:ink')).toMatchObject({
      subtype: 'Ink',
      inkPaths: 2,
      hasAppearance: true,
      opacity: 0.8,
    })
    expect(byKey('new:box')).toMatchObject({
      subtype: 'FreeText',
      hasAppearance: true,
      contents: 'A text box that wraps onto a second line',
    })
    expect(byKey('new:rect')).toMatchObject({ subtype: 'Square', hasAppearance: true })
    expect(byKey('new:oval')).toMatchObject({ subtype: 'Circle', hasAppearance: true })
    expect(byKey('new:arrow')).toMatchObject({
      subtype: 'Line',
      line: [320, 220, 450, 260],
      ends: ['None', 'OpenArrow'],
      hasAppearance: true,
    })
    expect(byKey('new:re')).toMatchObject({
      subtype: 'Text',
      inReplyTo: out.created['new:note'],
      author: 'Alice Example',
    })
  })

  it('reads back what it wrote as the staged list showed it (the viewer’s preview is the file)', async () => {
    const before = await makePdf([{ lines: ['Text'] }])
    const out = await applyPdfEdits({ bytes: before }, { annotations: everyKind }, ctx)
    const read = (await readPdfContents({ bytes: out.bytes })).annotations
    const staged = foldEdits([], everyKind, ctx)
    const rename = (id: string | null) => (id ? (out.created[id] ?? id) : null)
    const norm = (a: PdfAnnotation) => ({
      ...a,
      id: rename(a.id),
      inReplyTo: rename(a.inReplyTo),
      rect: a.rect.map((n) => Math.round(n)),
      color: a.color?.map((c) => Math.round(c * 100) / 100) ?? null,
      opacity: Math.round(a.opacity * 100) / 100,
      shape: a.shape
        ? JSON.parse(
            JSON.stringify(a.shape, (_, v) =>
              typeof v === 'number' ? Math.round(v * 100) / 100 : v,
            ),
          )
        : null,
    })
    expect(read.map(norm)).toEqual(staged.map(norm))
    const note = read.find((a) => a.id === out.created['new:note'])!
    expect(note.review).toEqual({
      state: 'Completed',
      author: 'Alice Example',
      modified: '2026-11-21T10:00:00.000Z',
    })
    expect(
      threadsOf(read)
        .find((t) => t.root.id === note.id)!
        .replies.map((r) => r.contents),
    ).toEqual(['Agreed'])
  })

  it('leaves the pages’ content streams as they were', async () => {
    const before = await makePdf([{ lines: ['One'] }, { lines: ['Two'] }])
    const out = await applyPdfEdits({ bytes: before }, { annotations: everyKind }, ctx)
    const [a, b] = await Promise.all([PDFDocument.load(before), PDFDocument.load(out.bytes)])
    expect(pageStream(b, 0)).toEqual(pageStream(a, 0))
    expect(pageStream(b, 1)).toEqual(pageStream(a, 1))
    expect(b.getPages()[1]!.node.Annots()?.size() ?? 0).toBe(0)
  })

  it('edits and deletes the file’s own annotations, keeping every key it doesn’t change', async () => {
    const before = await makePdf([{ lines: ['Text'] }], {
      notes: [{ page: 0, text: 'Original note' }],
    })
    const [existing] = (await readPdfContents({ bytes: before })).annotations
    expect(existing).toMatchObject({ kind: 'Text', contents: 'Original note', author: null })
    const doc = await PDFDocument.load(before)
    const ref = doc.getPages()[0]!.node.Annots()!.get(0) as PDFRef
    doc.context.lookup(ref, PDFDict).set(PDFName.of('Custom'), PDFName.of('Kept'))
    const marked = await doc.save()

    const moved = await applyPdfEdits(
      { bytes: marked },
      {
        annotations: [
          { op: 'update', id: existing!.id, patch: { move: [10, -20], contents: 'Changed' } },
        ],
      },
      ctx,
    )
    const reread = await PDFDocument.load(moved.bytes)
    const dict = reread.context.lookup(reread.getPages()[0]!.node.Annots()!.get(0), PDFDict)
    expect(dict.get(PDFName.of('Custom'))).toEqual(PDFName.of('Kept'))
    const [after] = (await readPdfContents({ bytes: moved.bytes })).annotations
    expect(after).toMatchObject({
      id: existing!.id,
      contents: 'Changed',
      rect: [410, 680, 430, 700],
      author: null,
      modified: '2026-11-21T10:00:00.000Z',
    })

    const withReply = await applyPdfEdits(
      { bytes: moved.bytes },
      { annotations: [{ op: 'reply', key: 'new:r', to: existing!.id, contents: 'A reply' }] },
      ctx,
    )
    expect((await readPdfContents({ bytes: withReply.bytes })).annotations).toHaveLength(2)
    const gone = await applyPdfEdits(
      { bytes: withReply.bytes },
      { annotations: [{ op: 'delete', id: existing!.id }] },
      ctx,
    )
    expect((await readPdfContents({ bytes: gone.bytes })).annotations).toEqual([])
    expect(await seenByPdfJs(gone.bytes)).toEqual([])
  })

  it('recolours a markup and redraws its appearance', async () => {
    const before = await makePdf([{ lines: ['Text'] }])
    const one = await applyPdfEdits({ bytes: before }, { annotations: [everyKind[0]!] }, ctx)
    const id = one.created['new:hl']!
    const two = await applyPdfEdits(
      { bytes: one.bytes },
      { annotations: [{ op: 'update', id, patch: { color: [0, 1, 0], opacity: 1 } }] },
      ctx,
    )
    expect((await seenByPdfJs(two.bytes))[0]).toMatchObject({
      id,
      color: [0, 255, 0],
      opacity: 1,
      hasAppearance: true,
    })
  })

  it('says plainly what can’t be done', async () => {
    const pdf = await makePdf([{ lines: ['Text'] }])
    const fails = (edits: AnnotationEdit[]) =>
      applyPdfEdits({ bytes: pdf }, { annotations: edits }, ctx)
    await expect(fails([{ op: 'delete', id: '999R' }])).rejects.toThrow(
      'There is no annotation 999R in this PDF.',
    )
    await expect(
      fails([
        {
          op: 'add',
          key: 'new:x',
          annotation: { page: 3, shape: { kind: 'Text', at: [0, 0] }, color: red, opacity: 1 },
        },
      ]),
    ).rejects.toThrow('There is no page 4; the PDF has 1 pages.')
    await expect(
      fails([
        {
          op: 'add',
          key: 'new:x',
          annotation: {
            page: 0,
            shape: { kind: 'FreeText', rect: [0, 0, 100, 40], fontSize: 12 },
            color: red,
            opacity: 1,
            contents: '確認',
          },
        },
      ]),
    ).rejects.toThrow(PdfEditError)
    await expect(
      applyPdfEdits({ bytes: pdf }, { annotations: everyKind }, { ...ctx, author: ' ' }),
    ).rejects.toThrow('Annotations need an author.')
    await expect(
      applyPdfEdits(
        { bytes: encryptedPdf('pw', 'x'), name: 'locked.pdf' },
        { annotations: everyKind },
        ctx,
      ),
    ).rejects.toThrow('“locked.pdf” is password-protected')
    await expect(applyPdfEdits({ bytes: pdf }, {}, ctx)).rejects.toThrow(
      'There is nothing to save.',
    )
  })

  it('stages the same way it writes: replies go with what they answer', () => {
    const list = foldEdits([], everyKind, ctx)
    expect(list.map((a) => a.id)).toContain('new:re')
    const after = foldEdits(list, [{ op: 'delete', id: 'new:note' }], ctx)
    expect(after.map((a) => a.id)).not.toContain('new:re')
    expect(() => foldEdits(list, [{ op: 'update', id: 'nope', patch: {} }], ctx)).toThrow(
      PdfEditError,
    )
  })
})
