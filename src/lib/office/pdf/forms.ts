import type { PDFDocument, PDFField, PDFFont } from 'pdf-lib'
/**
 * Interactive forms (plan/phase-office-files.md P3; ISO 32000-2 §12.7):
 * list an AcroForm's fields, fill them (honouring read-only, required and
 * maximum length), regenerate the filled fields' appearances so every reader
 * shows the values, and — only when asked — flatten the form into the pages.
 * XFA (§12.7.9, deprecated in PDF 2.0) can't be filled: an XFA-only form is
 * said to be one; a form that carries both keeps its AcroForm and loses the
 * XFA copy on save, with a warning.
 */
import {
  PDFAcroForm,
  PDFArray,
  PDFBool,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDropdown,
  PDFForm,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFTextField,
  StandardFonts,
} from 'pdf-lib/dist/pdf-lib.esm.js'
import { normRect, PdfEditError, type Rect } from './annotate-model'

export type FormFieldType =
  'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'signature' | 'button'
export type FieldValue = string | boolean | string[]

export type FormWidget = {
  /** 0-based page index. */
  page: number
  rect: Rect
  /** A radio button's or checkbox's on value. */
  option?: string
}

export type PdfFormField = {
  name: string
  type: FormFieldType
  /** text: the text; checkbox: checked; radio: the chosen option or null; dropdown / listbox: the chosen options. */
  value: string | boolean | string[] | null
  options: string[]
  readOnly: boolean
  required: boolean
  maxLength: number | null
  multiline: boolean
  /** A dropdown that takes text of its own. */
  editable: boolean
  multiselect: boolean
  /** A signature field that carries a signature (shown, never changed here). */
  signed: boolean
  widgets: FormWidget[]
}

/** none: no form; acroform: fillable; xfa-only: an XFA form, not fillable; hybrid: both (the AcroForm is filled). */
export type FormKind = 'none' | 'acroform' | 'xfa-only' | 'hybrid'

export type PdfFormInfo = { kind: FormKind; fields: PdfFormField[] }

export const XFA_ONLY_MESSAGE =
  'This is an XFA form, a format PDF 2.0 retired: it can’t be filled here. Fill it in a reader that supports XFA.'

function acroFormDict(doc: PDFDocument): PDFDict | undefined {
  return doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
}

function hasFields(dict: PDFDict | undefined): boolean {
  const fields = dict?.lookupMaybe(PDFName.of('Fields'), PDFArray)
  return !!fields && fields.size() > 0
}

export function formKind(doc: PDFDocument): FormKind {
  const dict = acroFormDict(doc)
  if (!dict) return 'none'
  const xfa = dict.has(PDFName.of('XFA'))
  const fields = hasFields(dict)
  if (xfa) return fields ? 'hybrid' : 'xfa-only'
  return fields ? 'acroform' : 'none'
}

/** The form without pdf-lib's own XFA handling (it would drop the XFA silently). */
function formOf(doc: PDFDocument): PDFForm {
  const dict = acroFormDict(doc)
  if (!dict) throw new PdfEditError('This PDF has no form.')
  return PDFForm.of(PDFAcroForm.fromDict(dict), doc)
}

function pageOfRefs(doc: PDFDocument): Map<PDFRef, number> {
  const out = new Map<PDFRef, number>()
  doc.getPages().forEach((page, i) => {
    const annots = page.node.Annots()
    for (let k = 0; annots && k < annots.size(); k++) {
      const ref = annots.get(k)
      if (ref instanceof PDFRef) out.set(ref, i)
    }
  })
  return out
}

function typeOf(field: PDFField): FormFieldType {
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFCheckBox) return 'checkbox'
  if (field instanceof PDFRadioGroup) return 'radio'
  if (field instanceof PDFDropdown) return 'dropdown'
  if (field instanceof PDFOptionList) return 'listbox'
  if (field instanceof PDFSignature) return 'signature'
  if (field instanceof PDFButton) return 'button'
  throw new PdfEditError(
    `The form field “${field.getName()}” is of a kind this viewer doesn’t know.`,
  )
}

function describe(doc: PDFDocument, field: PDFField, pages: Map<PDFRef, number>): PdfFormField {
  const type = typeOf(field)
  const pageRefs = doc.getPages().map((p) => p.ref)
  const options =
    field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList
      ? field.getOptions()
      : []
  const widgets: FormWidget[] = field.acroField.getWidgets().map((w, i) => {
    const ref = doc.context.getObjectRef(w.dict)
    const p = w.P()
    const page = (ref && pages.get(ref)) ?? (p ? pageRefs.indexOf(p) : -1)
    const r = w.getRectangle()
    const out: FormWidget = { page, rect: normRect([r.x, r.y, r.x + r.width, r.y + r.height]) }
    if (field instanceof PDFRadioGroup) out.option = options[i]
    if (field instanceof PDFCheckBox) out.option = w.getOnValue()?.decodeText()
    return out
  })
  let value: PdfFormField['value'] = null
  if (field instanceof PDFTextField) value = field.getText() ?? ''
  else if (field instanceof PDFCheckBox) value = field.isChecked()
  else if (field instanceof PDFRadioGroup) value = field.getSelected() ?? null
  else if (field instanceof PDFDropdown || field instanceof PDFOptionList)
    value = field.getSelected()
  return {
    name: field.getName(),
    type,
    value,
    options,
    readOnly: field.isReadOnly() || type === 'signature' || type === 'button',
    required: field.isRequired(),
    maxLength: field instanceof PDFTextField ? (field.getMaxLength() ?? null) : null,
    multiline: field instanceof PDFTextField ? field.isMultiline() : false,
    editable: field instanceof PDFDropdown ? field.isEditable() : false,
    multiselect:
      field instanceof PDFDropdown || field instanceof PDFOptionList
        ? field.isMultiselect()
        : false,
    signed: field instanceof PDFSignature ? field.acroField.dict.has(PDFName.of('V')) : false,
    widgets: widgets.filter((w) => w.page >= 0),
  }
}

export function readForm(doc: PDFDocument): PdfFormInfo {
  const kind = formKind(doc)
  if (kind === 'none' || kind === 'xfa-only') return { kind, fields: [] }
  const pages = pageOfRefs(doc)
  return {
    kind,
    fields: formOf(doc)
      .getFields()
      .map((f) => describe(doc, f, pages)),
  }
}

const isEmpty = (f: PdfFormField) =>
  f.value === null ||
  f.value === '' ||
  f.value === false ||
  (Array.isArray(f.value) && f.value.length === 0)

/** The required fields still empty. */
export function missingRequired(fields: PdfFormField[]): string[] {
  return fields.filter((f) => f.required && !f.readOnly && isEmpty(f)).map((f) => f.name)
}

/** Checks one value against its field; throws PdfEditError saying what is wrong. */
export function checkValue(field: PdfFormField, value: FieldValue): void {
  const label = `“${field.name}”`
  if (field.type === 'signature')
    throw new PdfEditError(`${label} is a signature field; it is shown, not filled here.`)
  if (field.type === 'button') throw new PdfEditError(`${label} is a button, not a field to fill.`)
  if (field.readOnly) throw new PdfEditError(`${label} is read-only.`)
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') throw new PdfEditError(`${label} takes text.`)
      if (field.maxLength !== null && [...value].length > field.maxLength)
        throw new PdfEditError(`${label} takes at most ${field.maxLength} characters.`)
      if (!field.multiline && /[\r\n]/.test(value))
        throw new PdfEditError(`${label} takes one line of text.`)
      return
    case 'checkbox':
      if (typeof value !== 'boolean')
        throw new PdfEditError(`${label} is a checkbox: true or false.`)
      return
    case 'radio':
      if (typeof value !== 'string')
        throw new PdfEditError(`${label} takes one of: ${field.options.join(', ')}.`)
      if (value !== '' && !field.options.includes(value))
        throw new PdfEditError(
          `${label} has no option “${value}”; it has ${field.options.join(', ')}.`,
        )
      return
    case 'dropdown':
    case 'listbox': {
      const list = typeof value === 'string' ? (value === '' ? [] : [value]) : value
      if (!Array.isArray(list) || list.some((v) => typeof v !== 'string'))
        throw new PdfEditError(`${label} takes one of: ${field.options.join(', ')}.`)
      if (list.length > 1 && !field.multiselect)
        throw new PdfEditError(`${label} takes one option.`)
      const unknown = list.find((v) => !field.options.includes(v))
      if (unknown !== undefined && !(field.type === 'dropdown' && field.editable))
        throw new PdfEditError(
          `${label} has no option “${unknown}”; it has ${field.options.join(', ')}.`,
        )
      return
    }
  }
}

/**
 * Fills fields (name → value) and regenerates the filled fields'
 * appearances. A value the standard font can't draw is left for the reader
 * to draw (/NeedAppearances) and said in the warnings.
 */
export async function fillForm(
  doc: PDFDocument,
  values: Record<string, FieldValue>,
): Promise<string[]> {
  const kind = formKind(doc)
  if (kind === 'xfa-only') throw new PdfEditError(XFA_ONLY_MESSAGE)
  if (kind === 'none') throw new PdfEditError('This PDF has no form to fill.')
  const warnings: string[] = []
  const form = formOf(doc)
  if (kind === 'hybrid') {
    form.deleteXFA()
    warnings.push(
      'The file also carried an XFA copy of the form; it was removed so every reader shows the values filled here.',
    )
  }
  const pages = pageOfRefs(doc)
  const byName = new Map(form.getFields().map((f) => [f.getName(), f]))
  const unknown = Object.keys(values).filter((n) => !byName.has(n))
  if (unknown.length)
    throw new PdfEditError(`This form has no field ${unknown.map((n) => `“${n}”`).join(', ')}.`)
  let font: PDFFont | null = null
  for (const [n, value] of Object.entries(values)) {
    const field = byName.get(n)!
    checkValue(describe(doc, field, pages), value)
    if (field instanceof PDFTextField) field.setText(value === '' ? undefined : (value as string))
    else if (field instanceof PDFCheckBox) {
      if (value) field.check()
      else field.uncheck()
    } else if (field instanceof PDFRadioGroup) {
      if (value === '') field.clear()
      else field.select(value as string)
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const list = typeof value === 'string' ? (value === '' ? [] : [value]) : (value as string[])
      if (list.length === 0) field.clear()
      else field.select(list)
    }
    if (!field.needsAppearancesUpdate()) continue
    font ??= await doc.embedFont(StandardFonts.Helvetica)
    try {
      field.defaultUpdateAppearances(font)
    } catch {
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True)
      warnings.push(
        `“${n}” has characters the standard PDF font can’t draw; readers draw its value themselves.`,
      )
    }
  }
  return warnings
}

/** Removes a field and its widgets (pdf-lib's removeField needs an appearance to exist). */
function dropField(doc: PDFDocument, form: PDFForm, field: PDFField) {
  const widgets = field.acroField.getWidgets().map((w) => doc.context.getObjectRef(w.dict))
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    for (let i = (annots?.size() ?? 0) - 1; annots && i >= 0; i--) {
      const ref = annots.get(i)
      if (widgets.includes(ref as PDFRef)) annots.remove(i)
    }
  }
  form.acroForm.removeField(field.acroField)
  for (const ref of widgets) if (ref) doc.context.delete(ref)
  doc.context.delete(field.ref)
}

/** Turns every field into page content: the values stay, the form is gone. */
export async function flattenForm(doc: PDFDocument): Promise<string[]> {
  const kind = formKind(doc)
  if (kind === 'xfa-only') throw new PdfEditError(XFA_ONLY_MESSAGE)
  if (kind === 'none') throw new PdfEditError('This PDF has no form to flatten.')
  const form = formOf(doc)
  const fields = readForm(doc).fields
  const signed = fields.filter((f) => f.signed).map((f) => `“${f.name}”`)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  form.updateFieldAppearances(font)
  // A field with nothing drawn (an empty signature field) has nothing to put on the page.
  const blank = form
    .getFields()
    .filter((f) => f.acroField.getWidgets().some((w) => !w.getAppearances()?.normal))
  for (const f of blank) dropField(doc, form, f)
  form.flatten({ updateFieldAppearances: false })
  const warnings = [
    'The form was flattened: its values are now part of the pages and can no longer be changed as fields.',
  ]
  if (blank.length)
    warnings.push(
      `Fields with nothing to show were removed: ${blank.map((f) => `“${f.getName()}”`).join(', ')}.`,
    )
  if (signed.length) warnings.push(`Signatures in ${signed.join(', ')} are no longer verifiable.`)
  return warnings
}
