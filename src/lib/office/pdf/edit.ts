/**
 * One save of the PDF viewer's Annotate / Fill form / Properties modes, and
 * the agent tools that do the same (plan/phase-office-files.md P3): every
 * staged change applied to the file in one pass and written as one new file,
 * in the browser and in Node alike.
 */
import { PDFDocument } from 'pdf-lib/dist/pdf-lib.esm.js'
import { applyAnnotationEdits, readAnnotations } from './annotate'
import {
  PdfEditError,
  type AnnotationEdit,
  type EditContext,
  type PdfAnnotation,
  type Rect,
} from './annotate-model'
import {
  fillForm,
  flattenForm,
  missingRequired,
  readForm,
  type FieldValue,
  type PdfFormInfo,
} from './forms'
import {
  readProperties,
  setProperties,
  touchModified,
  type PdfProperties,
  type PropertiesPatch,
} from './properties'

export { PdfEditError } from './annotate-model'

export type PdfSource = { bytes: Uint8Array; name?: string }

export type PdfEdits = {
  annotations?: AnnotationEdit[]
  fields?: Record<string, FieldValue>
  /** Turn the form into page content after filling (an explicit choice). */
  flatten?: boolean
  properties?: PropertiesPatch
}

export type EditResult = {
  bytes: Uint8Array
  /** Each thing worth knowing about the result, in a sentence. */
  warnings: string[]
  /** The id each new annotation or reply got (staged key → id). */
  created: Record<string, string>
}

/** A page as annotations see it: its crop box in user space and its turn. */
export type PageBox = { box: Rect; rotate: number }

export type PdfContents = {
  pages: PageBox[]
  annotations: PdfAnnotation[]
  form: PdfFormInfo
  properties: PdfProperties
}

function messageOf(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

export async function loadForEdit(source: PdfSource): Promise<PDFDocument> {
  const label = source.name ? `“${source.name}”` : 'The PDF'
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(source.bytes, { updateMetadata: false, ignoreEncryption: true })
  } catch (err) {
    throw new PdfEditError(`${label} could not be read: ${messageOf(err)}`)
  }
  if (doc.isEncrypted)
    throw new PdfEditError(
      `${label} is password-protected, so it can’t be annotated or filled here.`,
    )
  return doc
}

export function pageBoxes(doc: PDFDocument): PageBox[] {
  return doc.getPages().map((p) => {
    const b = p.getCropBox()
    return {
      box: [b.x, b.y, b.x + b.width, b.y + b.height],
      rotate: ((p.getRotation().angle % 360) + 360) % 360,
    }
  })
}

/** What the editing modes show: annotations, the form, the properties. */
export async function readPdfContents(source: PdfSource): Promise<PdfContents> {
  const doc = await loadForEdit(source)
  try {
    return {
      pages: pageBoxes(doc),
      annotations: readAnnotations(doc),
      form: readForm(doc),
      properties: readProperties(doc),
    }
  } catch (err) {
    if (err instanceof PdfEditError) throw err
    throw new PdfEditError(
      `${source.name ? `“${source.name}”` : 'The PDF'} could not be read: ${messageOf(err)}`,
    )
  }
}

export function hasEdits(e: PdfEdits): boolean {
  return !!(
    e.annotations?.length ||
    (e.fields && Object.keys(e.fields).length) ||
    e.flatten ||
    (e.properties && Object.keys(e.properties).length)
  )
}

/** Applies every staged change in one pass: annotations, then form values (and flattening), then properties. */
export async function applyPdfEdits(
  source: PdfSource,
  edits: PdfEdits,
  ctx: EditContext,
): Promise<EditResult> {
  if (!hasEdits(edits)) throw new PdfEditError('There is nothing to save.')
  const doc = await loadForEdit(source)
  const warnings: string[] = []
  const created = edits.annotations?.length
    ? await applyAnnotationEdits(doc, edits.annotations, ctx)
    : {}
  if (edits.fields && Object.keys(edits.fields).length)
    warnings.push(...(await fillForm(doc, edits.fields)))
  if (edits.flatten) warnings.push(...(await flattenForm(doc)))
  else if (edits.fields && Object.keys(edits.fields).length) {
    const missing = missingRequired(readForm(doc).fields)
    if (missing.length)
      warnings.push(`Required fields still empty: ${missing.map((n) => `“${n}”`).join(', ')}.`)
  }
  if (edits.properties && Object.keys(edits.properties).length)
    setProperties(doc, edits.properties, ctx.now)
  else touchModified(doc, ctx.now)
  const bytes = await doc.save({ addDefaultPage: false, updateFieldAppearances: false })
  return { bytes, warnings, created }
}
