import type { PDFContext, PDFObject } from 'pdf-lib'
/**
 * Page organisation for PDFs (plan/phase-office-files.md, P2): rotate,
 * delete, reorder, insert blank pages or pages of another PDF, extract,
 * split and merge. Runs the same in the browser (the viewer's Organise mode)
 * and in Node (the drive.pdf_* agent tools); pdf-lib (MIT) reads and writes
 * the objects, the structure rules come from ISO 32000-2.
 *
 * Every operation is one pass of `composePdf` over a page plan
 * (./organise-plan.ts). The first source is the base: its catalog — the
 * bookmarks, form, named destinations, page labels, metadata — is kept and
 * its pages stay the same objects, so links, annotations and form fields on
 * them keep working. Pages of other sources are copied in with their
 * annotations; links between copied pages, their form fields and their
 * bookmarks come along.
 *
 * What can't survive is dropped on purpose and said in `warnings`, never
 * silently: bookmarks and links that pointed at a page that is gone, form
 * fields that lived only on deleted pages, the tag tree once pages are
 * deleted or added. Deleted pages are really gone: objects only they used
 * are not written into the new file.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib/dist/pdf-lib.esm.js'
import {
  checkedPages,
  planDelete,
  planInsert,
  planMove,
  planPick,
  planReorder,
  planRotate,
  PdfOrganiseError,
  turn,
  wholeDocument,
  type PagePlan,
  type PageSlot,
  type Rotation,
} from './organise-plan'

export { PdfOrganiseError } from './organise-plan'

/** A PDF to read pages from; `name` is how messages refer to it (“report.pdf”). */
export type PdfSource = { bytes: Uint8Array; name?: string }

export type OrganiseResult = {
  bytes: Uint8Array
  /** Each thing that could not be kept, in a sentence (empty when nothing was lost). */
  warnings: string[]
}

/** An encrypted PDF: pdf-lib can't write it back, so its pages can't be changed. */
export class PdfEncryptedError extends PdfOrganiseError {
  constructor(name?: string) {
    super(
      `${name ? `“${name}”` : 'This PDF'} is password-protected, so its pages can’t be changed.`,
    )
    this.name = 'PdfEncryptedError'
  }
}

const N = (name: string) => PDFName.of(name)
const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const

type Loaded = { doc: PDFDocument; pages: PDFRef[]; label: string }

async function load(source: PdfSource): Promise<Loaded> {
  const label = source.name ? `“${source.name}”` : 'The PDF'
  let doc: PDFDocument
  try {
    // Loaded even when encrypted, only to say so: pdf-lib can't decrypt, so nothing else is read.
    doc = await PDFDocument.load(source.bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch (err) {
    throw new PdfOrganiseError(`${label} could not be read: ${messageOf(err)}`)
  }
  if (doc.isEncrypted) throw new PdfEncryptedError(source.name)
  let pages: PDFRef[]
  try {
    pages = doc.getPages().map((p) => p.ref)
  } catch (err) {
    throw new PdfOrganiseError(`${label} could not be read: ${messageOf(err)}`)
  }
  if (pages.length === 0) throw new PdfOrganiseError(`${label} has no pages.`)
  return { doc, pages, label }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Page count of a PDF (the same reading rules as the operations). */
export async function pdfPageCount(source: PdfSource): Promise<number> {
  return (await load(source)).pages.length
}

// ---------------------------------------------------------------------------
// The operations (0-based page indices)

/** Turns `pages` by `by` degrees clockwise (negative: anticlockwise; steps of 90). */
export async function rotatePages(
  pdf: PdfSource,
  pages: number[],
  by: number,
): Promise<OrganiseResult> {
  const { count } = await counted(pdf)
  return composePdf([pdf], planRotate(wholeDocument(count), pages, by))
}

/** Deletes `pages` (at least one page stays). */
export async function deletePages(pdf: PdfSource, pages: number[]): Promise<OrganiseResult> {
  const { count } = await counted(pdf)
  return composePdf([pdf], planDelete(wholeDocument(count), pages))
}

/** Moves `pages` (in their order) so the first of them becomes page `to` (0-based) of the result. */
export async function movePages(
  pdf: PdfSource,
  pages: number[],
  to: number,
): Promise<OrganiseResult> {
  const { count } = await counted(pdf)
  return composePdf([pdf], planMove(wholeDocument(count), pages, to))
}

/** Puts every page in a new order: `order` lists each page index once. */
export async function reorderPages(pdf: PdfSource, order: number[]): Promise<OrganiseResult> {
  const { count } = await counted(pdf)
  return composePdf([pdf], planReorder(wholeDocument(count), order))
}

/**
 * Inserts an empty page before position `at` (0 … page count), as big as
 * its neighbour looks (the page before it; the first page when it goes first).
 */
export async function insertBlankPage(pdf: PdfSource, at: number): Promise<OrganiseResult> {
  const { doc, count } = await counted(pdf)
  const neighbour = doc.getPage(Math.max(0, Math.min(count - 1, at - 1)))
  const box = neighbour.getCropBox()
  const quarter = neighbour.getRotation().angle % 180 !== 0
  const slot: PageSlot = {
    kind: 'blank',
    width: quarter ? box.height : box.width,
    height: quarter ? box.width : box.height,
  }
  return composePdf([pdf], planInsert(wholeDocument(count), at, [slot]))
}

/** Inserts the pages of `other` (all, or `pages` of it) before position `at`. */
export async function insertPages(
  pdf: PdfSource,
  at: number,
  other: PdfSource,
  pages?: number[],
): Promise<OrganiseResult> {
  const { count } = await counted(pdf)
  const otherCount = (await counted(other)).count
  const picked = pages
    ? planPick(wholeDocument(otherCount, 1), pages)
    : wholeDocument(otherCount, 1)
  return composePdf([pdf, other], planInsert(wholeDocument(count), at, picked))
}

/** A new PDF of `pages` (in document order). */
export async function extractPages(pdf: PdfSource, pages: number[]): Promise<OrganiseResult> {
  const { count } = await counted(pdf)
  return composePdf([pdf], planPick(wholeDocument(count), pages))
}

/** Several new PDFs, one per range (`from`…`to`, 0-based, inclusive; ranges may overlap). */
export async function splitPdf(
  pdf: PdfSource,
  ranges: Array<{ from: number; to: number }>,
): Promise<OrganiseResult[]> {
  const { count } = await counted(pdf)
  if (ranges.length === 0)
    throw new PdfOrganiseError('Name at least one range of pages to split off.')
  for (const r of ranges) {
    checkedPages([r.from], count)
    checkedPages([r.to], count)
    if (r.from > r.to)
      throw new PdfOrganiseError(`The range ${r.from + 1}–${r.to + 1} runs backwards.`)
  }
  const out: OrganiseResult[] = []
  for (const r of ranges) {
    const pages = Array.from({ length: r.to - r.from + 1 }, (_, k) => r.from + k)
    out.push(await composePdf([pdf], planPick(wholeDocument(count), pages)))
  }
  return out
}

/** One PDF of every page of `pdfs`, in order (the first one's bookmarks, form and metadata lead). */
export async function mergePdfs(pdfs: PdfSource[]): Promise<OrganiseResult> {
  if (pdfs.length < 2) throw new PdfOrganiseError('Merging needs at least two PDFs.')
  const plan: PageSlot[] = []
  for (const [source, pdf] of pdfs.entries())
    plan.push(...wholeDocument((await counted(pdf)).count, source))
  return composePdf(pdfs, plan)
}

async function counted(pdf: PdfSource) {
  const loaded = await load(pdf)
  return { doc: loaded.doc, count: loaded.pages.length }
}

// ---------------------------------------------------------------------------
// One pass: a plan → a PDF

/** Builds the PDF a plan describes. Source 0 is the base (see the module comment). */
export async function composePdf(sources: PdfSource[], plan: PagePlan): Promise<OrganiseResult> {
  if (sources.length === 0) throw new PdfOrganiseError('There is no PDF to take pages from.')
  if (plan.length === 0) throw new PdfOrganiseError('A PDF needs at least one page.')
  const loaded = await Promise.all(sources.map(load))
  const used = loaded.map(() => new Set<number>())
  for (const slot of plan) {
    if (slot.kind === 'blank') {
      if (!(slot.width > 0 && slot.height > 0))
        throw new PdfOrganiseError('A blank page needs a width and a height.')
      continue
    }
    const src = loaded[slot.source]
    if (!src) throw new PdfOrganiseError(`There is no source PDF ${slot.source + 1}.`)
    if (!Number.isInteger(slot.page) || slot.page < 0 || slot.page >= src.pages.length)
      throw new PdfOrganiseError(
        `${src.label} has no page ${slot.page + 1}; it has ${src.pages.length}.`,
      )
    if (used[slot.source]!.has(slot.page))
      throw new PdfOrganiseError(`Page ${slot.page + 1} of ${src.label} is used twice.`)
    used[slot.source]!.add(slot.page)
  }

  const warnings: string[] = []
  const base = loaded[0]!
  const context = base.doc.context
  const removedBase = new Set(base.pages.filter((_, i) => !used[0]!.has(i)))
  const structureChanged =
    plan.some((s) => s.kind === 'blank' || s.source !== 0) ||
    plan.some((s, i) => s.kind === 'page' && s.page !== i) ||
    removedBase.size > 0

  // Labels are read before anything moves.
  const labels = loaded.map((l) => readPageLabels(l.doc))

  // Prune every source against its own deleted pages first: nothing kept may point at them.
  loaded.forEach((src, i) => {
    const removed = new Set(src.pages.filter((_, p) => !used[i]!.has(p)))
    if (i === 0) pruneBase(src, removed, warnings)
    else if (used[i]!.size > 0) {
      pruneForeign(src, removed, warnings)
      // Gone before copying: whatever still points at a page left behind copies as null.
      for (const ref of removed) src.doc.context.delete(ref)
    }
  })

  // Base pages carry what they inherited, so they can move under a new page tree.
  for (const ref of base.pages) if (!removedBase.has(ref)) inheritOnto(context, ref)

  const copiers = new Map<number, PDFObjectCopier>()
  const copierFor = (i: number) => {
    let c = copiers.get(i)
    if (!c) {
      c = PDFObjectCopier.for(loaded[i]!.doc.context, context)
      copiers.set(i, c)
    }
    return c
  }
  const pagesRef = base.doc.catalog.get(N('Pages'))
  if (!(pagesRef instanceof PDFRef))
    throw new PdfOrganiseError(`${base.label} has no page tree it can be rebuilt from.`)

  const leaves: PDFRef[] = plan.map((slot) => {
    if (slot.kind === 'blank') {
      return context.register(
        context.obj({
          Type: 'Page',
          Parent: pagesRef,
          MediaBox: [0, 0, slot.width, slot.height],
          Resources: {},
        }),
      )
    }
    const own = loaded[slot.source]!.pages[slot.page]!
    const ref = slot.source === 0 ? own : (copierFor(slot.source).copy(own) as PDFRef)
    const leaf = context.lookup(ref, PDFDict)
    if (slot.source !== 0) stripStructParents(context, leaf)
    const was = context.lookupMaybe(leaf.get(N('Rotate')), PDFNumber)?.asNumber() ?? 0
    const next = turn(normalRotation(was), slot.rotate)
    if (next === 0) leaf.delete(N('Rotate'))
    else leaf.set(N('Rotate'), PDFNumber.of(next))
    return ref
  })

  // Copied pages' form fields and bookmarks join the base's.
  for (const [i, copier] of copiers) {
    adoptFields(base, loaded[i]!, copier, warnings)
    adoptOutline(base, loaded[i]!, copier)
  }

  // One flat page tree in plan order.
  context.assign(pagesRef, context.obj({ Type: 'Pages', Kids: leaves, Count: leaves.length }))
  for (const ref of leaves) context.lookup(ref, PDFDict).set(N('Parent'), pagesRef)

  if (structureChanged) writePageLabels(base.doc, plan, labels)
  base.doc.setModificationDate(new Date())
  collectGarbage(context, removedBase)
  const bytes = await base.doc.save({ addDefaultPage: false, updateFieldAppearances: false })
  return { bytes, warnings }
}

function normalRotation(r: number): Rotation {
  return turn(0, Number.isInteger(r / 90) ? r : 0)
}

/** Copies the inheritable page attributes (ISO 32000-2 §7.7.3.4) from the page's ancestors onto it. */
function inheritOnto(context: PDFContext, ref: PDFRef) {
  const leaf = context.lookup(ref, PDFDict)
  for (const key of INHERITED) {
    if (leaf.has(N(key))) continue
    let node = context.lookupMaybe(leaf.get(N('Parent')), PDFDict)
    const seen = new Set<PDFDict>()
    while (node && !seen.has(node)) {
      seen.add(node)
      const value = node.get(N(key))
      if (value) {
        leaf.set(N(key), value)
        break
      }
      node = context.lookupMaybe(node.get(N('Parent')), PDFDict)
    }
  }
}

// ---------------------------------------------------------------------------
// Destinations

/** The explicit destination array a destination (array, name, string, or { D }) stands for. */
function resolveDest(doc: PDFDocument, dest: PDFObject | undefined): PDFArray | null {
  const context = doc.context
  const value = dest instanceof PDFRef ? context.lookup(dest) : dest
  if (value instanceof PDFArray) return value
  if (value instanceof PDFDict) return resolveDest(doc, value.get(N('D')))
  let named: PDFObject | undefined
  if (value instanceof PDFName) {
    named = context.lookupMaybe(doc.catalog.get(N('Dests')), PDFDict)?.get(value)
  } else if (value instanceof PDFString || value instanceof PDFHexString) {
    const tree = context.lookupMaybe(
      context.lookupMaybe(doc.catalog.get(N('Names')), PDFDict)?.get(N('Dests')),
      PDFDict,
    )
    named = tree ? nameTreeGet(context, tree, value.decodeText()) : undefined
    // PDF 1.1 files may name destinations by string in the old /Dests dictionary too.
    named ??= context.lookupMaybe(doc.catalog.get(N('Dests')), PDFDict)?.get(N(value.decodeText()))
  } else return null
  if (named === undefined) return null
  const target = named instanceof PDFRef ? context.lookup(named) : named
  if (target instanceof PDFArray) return target
  if (target instanceof PDFDict) {
    const d = target.get(N('D'))
    const arr = d instanceof PDFRef ? context.lookup(d) : d
    return arr instanceof PDFArray ? arr : null
  }
  return null
}

function nameTreeGet(context: PDFContext, node: PDFDict, key: string): PDFObject | undefined {
  const names = context.lookupMaybe(node.get(N('Names')), PDFArray)
  if (names) {
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = context.lookup(names.get(i))
      if ((k instanceof PDFString || k instanceof PDFHexString) && k.decodeText() === key)
        return names.get(i + 1)
    }
  }
  const kids = context.lookupMaybe(node.get(N('Kids')), PDFArray)
  for (const kid of kids?.asArray() ?? []) {
    const child = context.lookupMaybe(kid, PDFDict)
    const found = child ? nameTreeGet(context, child, key) : undefined
    if (found !== undefined) return found
  }
  return undefined
}

/** Where a link, bookmark or open action goes: its destination, or a GoTo action's. */
function destOf(dict: PDFDict, context: PDFContext): { holder: PDFDict; key: string } | null {
  if (dict.has(N('Dest'))) return { holder: dict, key: 'Dest' }
  const action = context.lookupMaybe(dict.get(N('A')), PDFDict)
  if (action && context.lookupMaybe(action.get(N('S')), PDFName)?.asString() === '/GoTo')
    return { holder: action, key: 'D' }
  return null
}

/** The page a destination array targets (null: another file, or an index, not a page object). */
function destPage(dest: PDFArray | null): PDFRef | null {
  const first = dest?.get(0)
  return first instanceof PDFRef ? first : null
}

/** Whether a link or bookmark goes to one of `removed`; for copied documents, names become explicit. */
function pointsAtRemoved(
  doc: PDFDocument,
  dict: PDFDict,
  removed: Set<PDFRef>,
  makeExplicit: boolean,
): boolean {
  const where = destOf(dict, doc.context)
  if (!where) return false
  const raw = where.holder.get(N(where.key))
  const dest = resolveDest(doc, raw)
  if (isRemoved(destPage(dest), removed)) return true
  if (makeExplicit && dest && !(raw instanceof PDFArray)) where.holder.set(N(where.key), dest)
  if (makeExplicit && !dest) where.holder.delete(N(where.key)) // a name the copy can't resolve
  return false
}

// ---------------------------------------------------------------------------
// Pruning against deleted pages

function pruneBase(src: Loaded, removed: Set<PDFRef>, warnings: string[]) {
  if (removed.size === 0) return
  const { doc } = src
  const context = doc.context
  pruneOutline(doc, removed, warnings, false)
  pruneLinks(src, removed, warnings, false)
  pruneFields(src, removed, warnings)
  pruneNamedDests(doc, removed)
  const open = context.lookup(doc.catalog.get(N('OpenAction')))
  const opensRemoved =
    open instanceof PDFArray
      ? isRemoved(destPage(open), removed)
      : open instanceof PDFDict && pointsAtRemoved(doc, open, removed, false)
  if (opensRemoved) {
    doc.catalog.delete(N('OpenAction'))
    warnings.push('The file opened at a page that was deleted; it now opens at the first page.')
  }
  if (doc.catalog.has(N('StructTreeRoot'))) {
    doc.catalog.delete(N('StructTreeRoot'))
    doc.catalog.delete(N('MarkInfo'))
    warnings.push(
      'The accessibility tags (the tagged structure for screen readers) were removed because pages were deleted; the pages themselves look the same.',
    )
  }
  pruneThreads(src, removed, warnings)
}

function isRemoved(page: PDFRef | null, removed: Set<PDFRef>): boolean {
  return page !== null && removed.has(page)
}

function pruneForeign(src: Loaded, removed: Set<PDFRef>, warnings: string[]) {
  pruneOutline(src.doc, removed, warnings, true)
  pruneLinks(src, removed, warnings, true)
  pruneFields(src, removed, warnings)
}

type OutlineItem = { dict: PDFDict; ref: PDFRef; children: OutlineItem[]; open: boolean }

function readOutline(context: PDFContext, parent: PDFDict): OutlineItem[] {
  const out: OutlineItem[] = []
  const seen = new Set<PDFRef>()
  let ref = parent.get(N('First'))
  while (ref instanceof PDFRef && !seen.has(ref)) {
    seen.add(ref)
    const dict = context.lookupMaybe(ref, PDFDict)
    if (!dict) break
    const count = context.lookupMaybe(dict.get(N('Count')), PDFNumber)?.asNumber() ?? 0
    out.push({ dict, ref, children: readOutline(context, dict), open: count > 0 })
    ref = dict.get(N('Next'))
  }
  return out
}

/** Writes an item list back under `parent` (First/Last/Prev/Next/Parent/Count, ISO 32000-2 §12.3.3). */
function writeOutline(
  parentRef: PDFRef,
  parent: PDFDict,
  items: OutlineItem[],
  mode: 'root' | 'open' | 'closed',
) {
  items.forEach((item, i) => {
    item.dict.set(N('Parent'), parentRef)
    if (i > 0) item.dict.set(N('Prev'), items[i - 1]!.ref)
    else item.dict.delete(N('Prev'))
    if (i < items.length - 1) item.dict.set(N('Next'), items[i + 1]!.ref)
    else item.dict.delete(N('Next'))
    writeOutline(item.ref, item.dict, item.children, item.open ? 'open' : 'closed')
  })
  if (items.length === 0) {
    parent.delete(N('First'))
    parent.delete(N('Last'))
    if (mode === 'root') parent.set(N('Count'), PDFNumber.of(0))
    else parent.delete(N('Count'))
    return
  }
  parent.set(N('First'), items[0]!.ref)
  parent.set(N('Last'), items[items.length - 1]!.ref)
  const visible = items.reduce((n, it) => n + 1 + (it.open ? countVisible(it) : 0), 0)
  parent.set(N('Count'), PDFNumber.of(mode === 'closed' ? -visible : visible))
}

function countVisible(item: OutlineItem): number {
  return item.children.reduce((n, c) => n + 1 + (c.open ? countVisible(c) : 0), 0)
}

function outlineRoot(doc: PDFDocument): { ref: PDFRef; dict: PDFDict } | null {
  const ref = doc.catalog.get(N('Outlines'))
  if (!(ref instanceof PDFRef)) return null
  const dict = doc.context.lookupMaybe(ref, PDFDict)
  return dict ? { ref, dict } : null
}

function titleOf(context: PDFContext, dict: PDFDict): string {
  const t = context.lookup(dict.get(N('Title')))
  return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : '(untitled)'
}

/** Drops exactly the bookmarks that went to a deleted page; their children move up in their place. */
function pruneOutline(
  doc: PDFDocument,
  removed: Set<PDFRef>,
  warnings: string[],
  makeExplicit: boolean,
) {
  const root = outlineRoot(doc)
  if (!root) return
  const dropped: string[] = []
  const prune = (items: OutlineItem[]): OutlineItem[] =>
    items.flatMap((item) => {
      const children = prune(item.children)
      if (pointsAtRemoved(doc, item.dict, removed, makeExplicit)) {
        dropped.push(titleOf(doc.context, item.dict))
        return children
      }
      return [{ ...item, children }]
    })
  const items = prune(readOutline(doc.context, root.dict))
  if (dropped.length === 0 && !makeExplicit) return
  writeOutline(root.ref, root.dict, items, 'root')
  if (dropped.length)
    warnings.push(
      `${dropped.length === 1 ? 'A bookmark' : `${dropped.length} bookmarks`} went to deleted pages and ${dropped.length === 1 ? 'was' : 'were'} removed: ${dropped.map((t) => `“${t}”`).join(', ')}.`,
    )
}

function annotsOf(context: PDFContext, page: PDFRef): PDFArray | undefined {
  return context.lookupMaybe(context.lookup(page, PDFDict).get(N('Annots')), PDFArray)
}

/**
 * Removes links (on kept pages) that went to deleted pages; a button that
 * jumped there keeps its place but loses the jump.
 */
function pruneLinks(src: Loaded, removed: Set<PDFRef>, warnings: string[], makeExplicit: boolean) {
  const context = src.doc.context
  let count = 0
  for (const page of src.pages) {
    if (removed.has(page)) continue
    const annots = annotsOf(context, page)
    if (!annots) continue
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = context.lookupMaybe(annots.get(i), PDFDict)
      if (!annot || !pointsAtRemoved(src.doc, annot, removed, makeExplicit)) continue
      count += 1
      if (context.lookupMaybe(annot.get(N('Subtype')), PDFName)?.asString() === '/Link')
        annots.remove(i)
      else {
        annot.delete(N('Dest'))
        annot.delete(N('A'))
      }
    }
  }
  if (count)
    warnings.push(
      `${count === 1 ? 'A link' : `${count} links`} went to deleted pages and ${count === 1 ? 'was' : 'were'} removed.`,
    )
}

/** Removes the form fields (and widgets) that lived only on deleted pages. */
function pruneFields(src: Loaded, removed: Set<PDFRef>, warnings: string[]) {
  const context = src.doc.context
  const form = context.lookupMaybe(src.doc.catalog.get(N('AcroForm')), PDFDict)
  const fields = form && context.lookupMaybe(form.get(N('Fields')), PDFArray)
  if (!form || !fields || removed.size === 0) return
  const gone = new Set<PDFRef>()
  for (const page of removed)
    for (const a of annotsOf(context, page)?.asArray() ?? []) if (a instanceof PDFRef) gone.add(a)
  const kept = new Set<PDFRef>()
  for (const page of src.pages)
    if (!removed.has(page))
      for (const a of annotsOf(context, page)?.asArray() ?? []) if (a instanceof PDFRef) kept.add(a)
  const isGoneWidget = (ref: PDFRef, dict: PDFDict) => {
    if (kept.has(ref)) return false
    if (gone.has(ref)) return true
    const p = dict.get(N('P'))
    return p instanceof PDFRef && removed.has(p)
  }
  const droppedNames: string[] = []
  const removedFields = new Set<PDFRef>()
  /** Prunes a field's kids; returns whether the field itself still has a widget somewhere. */
  const visit = (ref: PDFRef, name: string): boolean => {
    const dict = context.lookupMaybe(ref, PDFDict)
    if (!dict) return false
    const t = context.lookup(dict.get(N('T')))
    const own = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : ''
    const full = own ? (name ? `${name}.${own}` : own) : name
    const kids = context.lookupMaybe(dict.get(N('Kids')), PDFArray)
    if (!kids) return !isGoneWidget(ref, dict)
    for (let i = kids.size() - 1; i >= 0; i--) {
      const kid = kids.get(i)
      if (!(kid instanceof PDFRef)) continue
      if (!visit(kid, full)) {
        kids.remove(i)
        removedFields.add(kid)
      }
    }
    return kids.size() > 0
  }
  for (let i = fields.size() - 1; i >= 0; i--) {
    const ref = fields.get(i)
    if (!(ref instanceof PDFRef)) continue
    const dict = context.lookupMaybe(ref, PDFDict)
    const t = dict && context.lookup(dict.get(N('T')))
    const name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : '(unnamed)'
    if (!visit(ref, '')) {
      fields.remove(i)
      removedFields.add(ref)
      droppedNames.unshift(name)
    }
  }
  const co = context.lookupMaybe(form.get(N('CO')), PDFArray)
  if (co)
    for (let i = co.size() - 1; i >= 0; i--) {
      const r = co.get(i)
      if (r instanceof PDFRef && removedFields.has(r)) co.remove(i)
    }
  if (droppedNames.length)
    warnings.push(
      `${droppedNames.length === 1 ? 'A form field' : `${droppedNames.length} form fields`} lived only on deleted pages and ${droppedNames.length === 1 ? 'was' : 'were'} removed: ${droppedNames.map((n) => `“${n}”`).join(', ')}.`,
    )
}

/** Named destinations that went to deleted pages are dropped (nothing left points at them). */
function pruneNamedDests(doc: PDFDocument, removed: Set<PDFRef>) {
  const context = doc.context
  const goesToRemoved = (v: PDFObject | undefined) => {
    const target = v instanceof PDFRef ? context.lookup(v) : v
    const arr =
      target instanceof PDFArray
        ? target
        : target instanceof PDFDict
          ? context.lookupMaybe(target.get(N('D')), PDFArray)
          : undefined
    return isRemoved(destPage(arr ?? null), removed)
  }
  const old = context.lookupMaybe(doc.catalog.get(N('Dests')), PDFDict)
  if (old) for (const key of old.keys()) if (goesToRemoved(old.get(key))) old.delete(key)
  const tree = context.lookupMaybe(
    context.lookupMaybe(doc.catalog.get(N('Names')), PDFDict)?.get(N('Dests')),
    PDFDict,
  )
  if (tree) pruneNameTree(context, tree, goesToRemoved, true)
}

/** Removes entries for which `drop` holds; fixes /Limits; returns the [first, last] keys left. */
function pruneNameTree(
  context: PDFContext,
  node: PDFDict,
  drop: (v: PDFObject | undefined) => boolean,
  isRoot: boolean,
): [PDFObject, PDFObject] | null {
  let first: PDFObject | null = null
  let last: PDFObject | null = null
  const names = context.lookupMaybe(node.get(N('Names')), PDFArray)
  if (names) {
    for (let i = names.size() - 2; i >= 0; i -= 2) {
      if (drop(names.get(i + 1))) {
        names.remove(i + 1)
        names.remove(i)
      }
    }
    if (names.size() >= 2) {
      first = names.get(0)
      last = names.get(names.size() - 2)
    }
  }
  const kids = context.lookupMaybe(node.get(N('Kids')), PDFArray)
  if (kids) {
    for (let i = kids.size() - 1; i >= 0; i--) {
      const child = context.lookupMaybe(kids.get(i), PDFDict)
      const range = child ? pruneNameTree(context, child, drop, false) : null
      if (!range) kids.remove(i)
    }
    for (const kid of kids.asArray()) {
      const lim = context.lookupMaybe(context.lookupMaybe(kid, PDFDict)?.get(N('Limits')), PDFArray)
      if (!lim) continue
      first ??= lim.get(0)
      last = lim.get(1)
    }
  }
  if (!isRoot && first && last) node.set(N('Limits'), context.obj([first, last]))
  return first && last ? [first, last] : null
}

/** Article threads with beads on deleted pages are removed (ISO 32000-2 §12.4.3). */
function pruneThreads(src: Loaded, removed: Set<PDFRef>, warnings: string[]) {
  const context = src.doc.context
  const threads = context.lookupMaybe(src.doc.catalog.get(N('Threads')), PDFArray)
  if (!threads) return
  let touched = false
  for (const page of removed) if (context.lookup(page, PDFDict).has(N('B'))) touched = true
  if (!touched) return
  src.doc.catalog.delete(N('Threads'))
  for (const page of src.pages) context.lookup(page, PDFDict).delete(N('B'))
  warnings.push('The article threads ran through deleted pages and were removed.')
}

// ---------------------------------------------------------------------------
// Copied pages: tags, form fields, bookmarks

/** A copied page's tag references point into its old file's tag tree: drop them. */
function stripStructParents(context: PDFContext, leaf: PDFDict) {
  leaf.delete(N('StructParents'))
  for (const a of context.lookupMaybe(leaf.get(N('Annots')), PDFArray)?.asArray() ?? [])
    context.lookupMaybe(a, PDFDict)?.delete(N('StructParent'))
}

/** The copied pages' top-level form fields join the base form (a clashing name gets a suffix). */
function adoptFields(base: Loaded, src: Loaded, copier: PDFObjectCopier, warnings: string[]) {
  const from = src.doc.context
  const to = base.doc.context
  const theirForm = from.lookupMaybe(src.doc.catalog.get(N('AcroForm')), PDFDict)
  const theirFields = theirForm && from.lookupMaybe(theirForm.get(N('Fields')), PDFArray)
  if (!theirForm || !theirFields || theirFields.size() === 0) return
  let ourForm = to.lookupMaybe(base.doc.catalog.get(N('AcroForm')), PDFDict)
  if (!ourForm) {
    ourForm = to.obj({ Fields: [] })
    for (const key of ['DA', 'DR', 'NeedAppearances', 'Q'])
      if (theirForm.has(N(key))) ourForm.set(N(key), copier.copy(theirForm.get(N(key))!))
    base.doc.catalog.set(N('AcroForm'), to.register(ourForm))
  }
  let ourFields = to.lookupMaybe(ourForm.get(N('Fields')), PDFArray)
  if (!ourFields) {
    ourFields = to.obj([])
    ourForm.set(N('Fields'), ourFields)
  }
  const taken = new Set<string>()
  for (const f of ourFields.asArray()) {
    const t = to.lookupMaybe(f, PDFDict)?.get(N('T'))
    const v = t && to.lookup(t)
    if (v instanceof PDFString || v instanceof PDFHexString) taken.add(v.decodeText())
  }
  const renamed: string[] = []
  for (const f of theirFields.asArray()) {
    if (!(f instanceof PDFRef)) continue
    const ref = copier.copy(f) as PDFRef
    const dict = to.lookup(ref, PDFDict)
    const t = to.lookup(dict.get(N('T')))
    let name = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : ''
    if (name && taken.has(name)) {
      const original = name
      let k = 2
      while (taken.has(`${original} (${k})`)) k += 1
      name = `${original} (${k})`
      dict.set(N('T'), PDFHexString.fromText(name))
      renamed.push(`“${original}” → “${name}”`)
    }
    if (name) taken.add(name)
    ourFields.push(ref)
  }
  if (renamed.length)
    warnings.push(
      `Form fields from ${src.label} had the same names as fields already here and were renamed so both still fill on their own: ${renamed.join(', ')}.`,
    )
}

/** The copied document's bookmarks go after the base's (they point at the copied pages). */
function adoptOutline(base: Loaded, src: Loaded, copier: PDFObjectCopier) {
  const theirs = outlineRoot(src.doc)
  if (!theirs || !theirs.dict.has(N('First'))) return
  const context = base.doc.context
  let ours = outlineRoot(base.doc)
  if (!ours) {
    const dict = context.obj({ Type: 'Outlines', Count: 0 })
    const ref = context.register(dict)
    base.doc.catalog.set(N('Outlines'), ref)
    ours = { ref, dict }
  }
  const copiedRoot = context.lookup(copier.copy(theirs.ref) as PDFRef, PDFDict)
  const items = [...readOutline(context, ours.dict), ...readOutline(context, copiedRoot)]
  writeOutline(ours.ref, ours.dict, items, 'root')
}

// ---------------------------------------------------------------------------
// Page labels (ISO 32000-2 §12.4.2)

/** Every page's label, or null when the file has none. */
function readPageLabels(doc: PDFDocument): string[] | null {
  const context = doc.context
  const tree = context.lookupMaybe(doc.catalog.get(N('PageLabels')), PDFDict)
  if (!tree) return null
  const ranges: Array<{ from: number; dict: PDFDict }> = []
  const walk = (node: PDFDict) => {
    const nums = context.lookupMaybe(node.get(N('Nums')), PDFArray)
    if (nums)
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const from = context.lookupMaybe(nums.get(i), PDFNumber)?.asNumber()
        const dict = context.lookupMaybe(nums.get(i + 1), PDFDict)
        if (from !== undefined && dict) ranges.push({ from, dict })
      }
    for (const kid of context.lookupMaybe(node.get(N('Kids')), PDFArray)?.asArray() ?? []) {
      const child = context.lookupMaybe(kid, PDFDict)
      if (child) walk(child)
    }
  }
  walk(tree)
  ranges.sort((a, b) => a.from - b.from)
  const count = doc.getPageCount()
  return Array.from({ length: count }, (_, i) => {
    const range = [...ranges].reverse().find((r) => r.from <= i)
    if (!range) return String(i + 1)
    const style = context
      .lookupMaybe(range.dict.get(N('S')), PDFName)
      ?.asString()
      .slice(1)
    const p = context.lookup(range.dict.get(N('P')))
    const prefix = p instanceof PDFString || p instanceof PDFHexString ? p.decodeText() : ''
    const start = context.lookupMaybe(range.dict.get(N('St')), PDFNumber)?.asNumber() ?? 1
    return prefix + formatLabel(style, start + i - range.from)
  })
}

function formatLabel(style: string | undefined, n: number): string {
  switch (style) {
    case 'D':
      return String(n)
    case 'R':
      return roman(n)
    case 'r':
      return roman(n).toLowerCase()
    case 'A':
      return letters(n)
    case 'a':
      return letters(n).toLowerCase()
    default:
      return ''
  }
}

function roman(n: number): string {
  const table: Array<[number, string]> = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ]
  let out = ''
  for (const [value, digits] of table)
    while (n >= value) {
      out += digits
      n -= value
    }
  return out
}

/** A, B, … Z, AA, BB, … (ISO 32000-2 Table 161). */
function letters(n: number): string {
  const letter = String.fromCharCode(65 + ((n - 1) % 26))
  return letter.repeat(Math.floor((n - 1) / 26) + 1)
}

/**
 * Rewrites /PageLabels after pages moved: each page keeps the label it had
 * (one range per page, the label as its prefix); pages from a file without
 * labels and blank pages are labelled with their new page number.
 */
function writePageLabels(doc: PDFDocument, plan: PagePlan, labels: Array<string[] | null>) {
  if (!labels.some((l, i) => l && plan.some((s) => s.kind === 'page' && s.source === i))) {
    doc.catalog.delete(N('PageLabels'))
    return
  }
  const context = doc.context
  const nums: PDFObject[] = []
  plan.forEach((slot, i) => {
    const label =
      slot.kind === 'page' && labels[slot.source] ? labels[slot.source]![slot.page]! : String(i + 1)
    nums.push(PDFNumber.of(i), context.obj({ P: PDFHexString.fromText(label) }))
  })
  doc.catalog.set(N('PageLabels'), context.obj({ Nums: nums }))
}

// ---------------------------------------------------------------------------
// Garbage: objects nothing reaches anymore are not written

/**
 * Deletes every object the trailer no longer reaches. Deleted pages are a
 * hard stop: whatever still points at one (a stray structure we don't know)
 * points at nothing (null, ISO 32000-2 §7.3.10), so a deleted page's content
 * never ends up in the new file.
 */
function collectGarbage(context: PDFContext, deletedPages: Set<PDFRef>) {
  const reachable = new Set<PDFRef>()
  const stack: PDFObject[] = []
  const { Root, Info } = context.trailerInfo
  if (Root) stack.push(Root)
  if (Info) stack.push(Info)
  while (stack.length) {
    const obj = stack.pop()!
    if (obj instanceof PDFRef) {
      if (deletedPages.has(obj) || reachable.has(obj)) continue
      reachable.add(obj)
      const value = context.lookup(obj)
      if (value) stack.push(value)
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v)
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) stack.push(v)
    } else if (obj instanceof PDFStream) {
      for (const [, v] of obj.dict.entries()) stack.push(v)
    }
  }
  for (const [ref] of context.enumerateIndirectObjects())
    if (!reachable.has(ref)) context.delete(ref)
}
