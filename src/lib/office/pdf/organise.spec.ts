import { PDFArray, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib/dist/pdf-lib.esm.js'
import { describe, expect, it } from 'vitest'
import { brokenPdf, encryptedPdf, makePdf, type FixtureOptions, type FixturePage } from './fixtures'
import {
  deletePages,
  extractPages,
  insertBlankPage,
  insertPages,
  mergePdfs,
  movePages,
  PdfEncryptedError,
  PdfOrganiseError,
  reorderPages,
  rotatePages,
  splitPdf,
} from './organise'
import { extractText } from './text'

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

type Inspected = {
  /** The first line of each page's text ('' for an empty page). */
  heads: string[]
  rotations: number[]
  /** Width × height as seen (points, rotation applied). */
  sizes: Array<[number, number]>
  /** Bookmarks as "title→page" (1-based), children indented with "  ". */
  outline: string[]
  /** Per page, where its links go (1-based page numbers). */
  links: number[][]
  fields: string[]
  notes: string[][]
  labels: string[] | null
}

/** Reads a result back with pdf.js (an independent reader): what a person would see. */
async function inspect(bytes: Uint8Array): Promise<Inspected> {
  const { getDocument } = await lib()
  const task = getDocument({ data: bytes.slice(), verbosity: 0, stopAtErrors: true })
  const doc = await task.promise
  try {
    const out: Inspected = {
      heads: [],
      rotations: [],
      sizes: [],
      outline: [],
      links: [],
      fields: [],
      notes: [],
      labels: await doc.getPageLabels(),
    }
    const pageOf = async (dest: unknown): Promise<number> => {
      const arr = typeof dest === 'string' ? await doc.getDestination(dest) : dest
      if (!Array.isArray(arr)) return -1
      return (await doc.getPageIndex(arr[0])) + 1
    }
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      const text = await page.getTextContent()
      const first = text.items.find((i) => 'str' in i && i.str.trim())
      out.heads.push(first && 'str' in first ? first.str : '')
      out.rotations.push(page.rotate)
      const v = page.getViewport({ scale: 1 })
      out.sizes.push([Math.round(v.width), Math.round(v.height)])
      const annots = await page.getAnnotations()
      const links: number[] = []
      const notes: string[] = []
      for (const a of annots) {
        if (a.subtype === 'Link' && a.dest) links.push(await pageOf(a.dest))
        if (a.subtype === 'Text') notes.push(a.contentsObj?.str ?? '')
        if (a.subtype === 'Widget') out.fields.push(a.fieldName)
      }
      out.links.push(links)
      out.notes.push(notes)
    }
    const walk = async (
      nodes: Array<{ title: string; dest: unknown; items: unknown[] }>,
      depth: number,
    ) => {
      for (const node of nodes) {
        out.outline.push(`${'  '.repeat(depth)}${node.title}→${await pageOf(node.dest)}`)
        await walk(node.items as typeof nodes, depth + 1)
      }
    }
    await walk(((await doc.getOutline()) ?? []) as never, 0)
    out.fields.sort()
    // The form itself (/AcroForm) lists the same fields as the pages' widgets.
    const form = (await PDFDocument.load(bytes)).getForm()
    expect(
      form
        .getFields()
        .map((f) => f.getName())
        .sort(),
    ).toEqual(out.fields)
    return out
  } finally {
    await task.destroy()
  }
}

const LETTER: [number, number] = [612, 792]
const LANDSCAPE: [number, number] = [792, 612]

function pages(
  n: number,
  opts: { landscape?: number[]; rotate?: Record<number, 90 | 180 | 270> } = {},
): FixturePage[] {
  return Array.from({ length: n }, (_, i) => ({
    lines: [`Page ${i + 1} heading`, `Body of page ${i + 1}.`],
    size: opts.landscape?.includes(i) ? LANDSCAPE : LETTER,
    rotate: opts.rotate?.[i],
  }))
}

async function pdf(n: number, opts: FixtureOptions = {}, extra: Parameters<typeof pages>[1] = {}) {
  return { bytes: await makePdf(pages(n, extra), opts), name: 'report.pdf' }
}

const heads = (n: number[]) => n.map((i) => `Page ${i} heading`)

describe('PDF page organisation (pdf-lib, browser and Node)', () => {
  it('rotates single pages by quarter turns, on top of their own rotation', async () => {
    const src = await pdf(3, {}, { rotate: { 2: 90 } })
    const out = await rotatePages(src, [1], 90)
    let seen = await inspect(out.bytes)
    expect(seen.rotations).toEqual([0, 90, 90])
    expect(seen.heads).toEqual(heads([1, 2, 3]))
    expect(seen.sizes[1]).toEqual([792, 612])
    expect(out.warnings).toEqual([])
    seen = await inspect((await rotatePages(src, [2], -90)).bytes)
    expect(seen.rotations).toEqual([0, 0, 0])
    seen = await inspect((await rotatePages(src, [0, 2], 180)).bytes)
    expect(seen.rotations).toEqual([180, 0, 270])
    await expect(rotatePages(src, [0], 45)).rejects.toThrow('Pages turn in steps of 90°, not 45°.')
  })

  it('deletes pages, and their content is not written into the new file', async () => {
    const src = await pdf(5)
    const original = await PDFDocument.load(src.bytes)
    const contents = original.context.lookup(original.getPage(1).node.get(PDFName.of('Contents')))
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((r) => original.context.lookup(r))
        : [contents]
    const secretBytes = (streams[0] as PDFRawStream).contents
    expect(secretBytes.length).toBeGreaterThan(20)
    const out = await deletePages(src, [1, 3])
    const seen = await inspect(out.bytes)
    expect(seen.heads).toEqual(heads([1, 3, 5]))
    expect(includesBytes(out.bytes, secretBytes)).toBe(false)
    expect(includesBytes(src.bytes, secretBytes)).toBe(true)
    expect(out.warnings).toEqual([])
    // The agent's text view agrees.
    const text = await extractText(out.bytes)
    expect(text).toContain('Page 3 heading')
    expect(text).not.toContain('Page 2 heading')
  })

  it('a deleted page’s bookmarks, links and form fields go, exactly those, and the result says so', async () => {
    const src = await pdf(5, {
      outline: [
        { title: 'Introduction', page: 0 },
        { title: 'Results', page: 3, children: [{ title: 'Tables', page: 4 }] },
      ],
      links: [
        { from: 0, to: 3 },
        { from: 0, to: 4 },
        { from: 1, to: 3, named: 'results' },
        { from: 1, to: 2, named: 'methods' },
      ],
      fields: [
        { name: 'reviewer', page: 1, value: 'Ada' },
        { name: 'approval', page: 3 },
      ],
      notes: [{ page: 4, text: 'Check the totals' }],
    })
    const before = await inspect(src.bytes)
    expect(before.links).toEqual([[4, 5], [4, 3], [], [], []])
    expect(before.fields).toEqual(['approval', 'reviewer'])

    const out = await deletePages(src, [3])
    const seen = await inspect(out.bytes)
    expect(seen.heads).toEqual(heads([1, 2, 3, 5]))
    expect(seen.outline).toEqual(['Introduction→1', 'Tables→4'])
    expect(seen.links).toEqual([[4], [3], [], []])
    expect(seen.fields).toEqual(['reviewer'])
    expect(seen.notes).toEqual([[], [], [], ['Check the totals']])
    expect(out.warnings).toEqual([
      'A bookmark went to deleted pages and was removed: “Results”.',
      '2 links went to deleted pages and were removed.',
      'A form field lived only on deleted pages and was removed: “approval”.',
    ])
  })

  it('moves a set of pages to a position; links still go to the same pages', async () => {
    const src = await pdf(5, { links: [{ from: 0, to: 4 }], outline: [{ title: 'End', page: 4 }] })
    const out = await movePages(src, [3, 4], 0)
    const seen = await inspect(out.bytes)
    expect(seen.heads).toEqual(heads([4, 5, 1, 2, 3]))
    expect(seen.links[2]).toEqual([2])
    expect(seen.outline).toEqual(['End→2'])
    expect((await inspect((await movePages(src, [0], 4)).bytes)).heads).toEqual(
      heads([2, 3, 4, 5, 1]),
    )
    await expect(movePages(src, [0, 1], 4)).rejects.toThrow(
      'Moved pages can start at position 1 to 4, not 5.',
    )
  })

  it('reorders by a full new order', async () => {
    const src = await pdf(4)
    expect((await inspect((await reorderPages(src, [3, 1, 0, 2])).bytes)).heads).toEqual(
      heads([4, 2, 1, 3]),
    )
    await expect(reorderPages(src, [0, 1, 2])).rejects.toThrow('must list every page once')
    await expect(reorderPages(src, [0, 1, 1, 2])).rejects.toThrow('Page 2 is named twice.')
  })

  it('inserts a blank page as big as its neighbour looks', async () => {
    const src = await pdf(3, {}, { landscape: [1], rotate: { 0: 90 } })
    const afterLandscape = await inspect((await insertBlankPage(src, 2)).bytes)
    expect(afterLandscape.heads).toEqual(['Page 1 heading', 'Page 2 heading', '', 'Page 3 heading'])
    expect(afterLandscape.sizes[2]).toEqual([792, 612])
    expect(afterLandscape.rotations[2]).toBe(0)
    // First: next to page 1, which is portrait turned a quarter (so it looks landscape).
    const first = await inspect((await insertBlankPage(src, 0)).bytes)
    expect(first.heads[0]).toBe('')
    expect(first.sizes[0]).toEqual([792, 612])
    await expect(insertBlankPage(src, 5)).rejects.toThrow(
      'Pages can be inserted at position 1 to 4, not 6.',
    )
  })

  it('inserts pages from another PDF with their links, fields and bookmarks', async () => {
    const src = await pdf(3, {
      outline: [{ title: 'Start', page: 0 }],
      fields: [{ name: 'notes', page: 0 }],
    })
    const other = {
      name: 'appendix.pdf',
      bytes: await makePdf(
        [{ lines: ['Appendix A'] }, { lines: ['Appendix B'] }, { lines: ['Appendix C'] }],
        {
          outline: [{ title: 'Appendix', page: 0, children: [{ title: 'B', page: 1 }] }],
          links: [
            { from: 0, to: 1 },
            { from: 0, to: 2, named: 'c' },
          ],
          fields: [
            { name: 'notes', page: 1 },
            { name: 'signoff', page: 1 },
          ],
        },
      ),
    }
    const out = await insertPages(src, 1, other)
    const seen = await inspect(out.bytes)
    expect(seen.heads).toEqual([
      'Page 1 heading',
      'Appendix A',
      'Appendix B',
      'Appendix C',
      'Page 2 heading',
      'Page 3 heading',
    ])
    expect(seen.links[1]).toEqual([3, 4])
    expect(seen.outline).toEqual(['Start→1', 'Appendix→2', '  B→3'])
    expect(seen.fields).toEqual(['notes', 'notes (2)', 'signoff'])
    expect(out.warnings).toEqual([
      'Form fields from “appendix.pdf” had the same names as fields already here and were renamed so both still fill on their own: “notes” → “notes (2)”.',
    ])

    // Only some pages of it: links to the pages left behind go, and say so.
    const some = await insertPages(src, 3, other, [0])
    const part = await inspect(some.bytes)
    expect(part.heads).toEqual([...heads([1, 2, 3]), 'Appendix A'])
    expect(part.links[3]).toEqual([])
    expect(part.outline).toEqual(['Start→1', 'Appendix→4'])
    expect(part.fields).toEqual(['notes'])
    expect(some.warnings).toEqual([
      'A bookmark went to deleted pages and was removed: “B”.',
      '2 links went to deleted pages and were removed.',
      '2 form fields lived only on deleted pages and were removed: “notes”, “signoff”.',
    ])
  })

  it('extracts pages into a new PDF (bookmarks of the other pages left out)', async () => {
    const src = await pdf(5, {
      outline: [
        { title: 'One', page: 0 },
        { title: 'Four', page: 3 },
      ],
    })
    const out = await extractPages(src, [3, 1])
    const seen = await inspect(out.bytes)
    expect(seen.heads).toEqual(heads([2, 4]))
    expect(seen.outline).toEqual(['Four→2'])
    expect(out.warnings).toEqual(['A bookmark went to deleted pages and was removed: “One”.'])
  })

  it('splits by ranges into several PDFs', async () => {
    const src = await pdf(6)
    const parts = await splitPdf(src, [
      { from: 0, to: 1 },
      { from: 2, to: 5 },
    ])
    expect(parts).toHaveLength(2)
    expect((await inspect(parts[0]!.bytes)).heads).toEqual(heads([1, 2]))
    expect((await inspect(parts[1]!.bytes)).heads).toEqual(heads([3, 4, 5, 6]))
    await expect(splitPdf(src, [{ from: 3, to: 1 }])).rejects.toThrow(
      'The range 4–2 runs backwards.',
    )
    await expect(splitPdf(src, [{ from: 0, to: 6 }])).rejects.toThrow(
      'There is no page 7; the PDF has 6 pages.',
    )
  })

  it('merges several PDFs into one, keeping each one’s bookmarks and page labels', async () => {
    const a = await pdf(2, {
      outline: [{ title: 'Part A', page: 0 }],
      labels: [{ from: 0, style: 'r' }],
    })
    const b = {
      name: 'b.pdf',
      bytes: await makePdf([{ lines: ['B one'] }, { lines: ['B two'] }], {
        outline: [{ title: 'Part B', page: 1 }],
      }),
    }
    const out = await mergePdfs([a, b])
    const seen = await inspect(out.bytes)
    expect(seen.heads).toEqual(['Page 1 heading', 'Page 2 heading', 'B one', 'B two'])
    expect(seen.outline).toEqual(['Part A→1', 'Part B→4'])
    expect(seen.labels).toEqual(['i', 'ii', '3', '4'])
    expect(out.warnings).toEqual([])
    await expect(mergePdfs([a])).rejects.toThrow('Merging needs at least two PDFs.')
  })

  it('page labels follow their pages', async () => {
    const src = await pdf(4, {
      labels: [
        { from: 0, style: 'r' },
        { from: 2, style: 'D' },
      ],
    })
    expect((await inspect((await deletePages(src, [0])).bytes)).labels).toEqual(['ii', '1', '2'])
    expect((await inspect((await movePages(src, [3], 0)).bytes)).labels).toEqual([
      '2',
      'i',
      'ii',
      '1',
    ])
    // Only turning pages leaves the labels as the file wrote them.
    expect((await inspect((await rotatePages(src, [0], 90)).bytes)).labels).toEqual([
      'i',
      'ii',
      '1',
      '2',
    ])
  })

  it('refuses what it can’t do with a clear error', async () => {
    const src = await pdf(2)
    await expect(deletePages(src, [0, 1])).rejects.toThrow(
      'A PDF needs at least one page, so not every page can be deleted.',
    )
    await expect(deletePages(src, [2])).rejects.toThrow('There is no page 3; the PDF has 2 pages.')
    await expect(extractPages(src, [])).rejects.toThrow('Choose at least one page.')
    await expect(
      rotatePages({ bytes: brokenPdf(), name: 'broken.pdf' }, [0], 90),
    ).rejects.toBeInstanceOf(PdfOrganiseError)
  })

  it('an encrypted PDF fails with a clear error', async () => {
    const locked = { bytes: encryptedPdf('s3cret', 'Hidden'), name: 'locked.pdf' }
    await expect(rotatePages(locked, [0], 90)).rejects.toBeInstanceOf(PdfEncryptedError)
    await expect(rotatePages(locked, [0], 90)).rejects.toThrow(
      '“locked.pdf” is password-protected, so its pages can’t be changed.',
    )
    await expect(mergePdfs([await pdf(1), locked])).rejects.toThrow(
      '“locked.pdf” is password-protected',
    )
  })
})

function includesBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}
