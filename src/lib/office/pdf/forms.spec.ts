import { PDFDocument, PDFName } from 'pdf-lib/dist/pdf-lib.esm.js'
import { describe, expect, it } from 'vitest'
import { applyPdfEdits, readPdfContents } from './edit'
import { makeFormPdf, makePdf } from './fixtures'
import { XFA_ONLY_MESSAGE } from './forms'

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

/** Field values as pdf.js (an independent reader) sees them. */
async function valuesSeen(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const { getDocument } = await lib()
  const task = getDocument({ data: bytes.slice(), verbosity: 0 })
  const doc = await task.promise
  try {
    const out: Record<string, unknown> = {}
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      for (const a of (await page.getAnnotations()) as Array<Record<string, unknown>>) {
        if (a.subtype !== 'Widget') continue
        const name = a.fieldName as string
        if (a.radioButton) {
          if (a.fieldValue === a.buttonValue) out[name] = a.buttonValue
        } else if (a.checkBox) out[name] = a.fieldValue === a.exportValue ? a.exportValue : 'Off'
        else out[name] = a.fieldValue
      }
    }
    return out
  } finally {
    await task.destroy()
  }
}

const ctx = { author: 'Alice', now: new Date('2026-11-21T10:00:00Z') }

describe('PDF forms', () => {
  it('lists every field with its kind, value, options, flags and place', async () => {
    const { form } = await readPdfContents({ bytes: await makeFormPdf() })
    expect(form.kind).toBe('acroform')
    const by = Object.fromEntries(form.fields.map((f) => [f.name, f]))
    expect(Object.keys(by).sort()).toEqual([
      'agree',
      'country',
      'locked',
      'name',
      'notes',
      'sign',
      'size',
      'toppings',
    ])
    expect(by.name).toMatchObject({
      type: 'text',
      value: '',
      required: true,
      maxLength: 20,
      readOnly: false,
      multiline: false,
    })
    expect(by.name!.widgets.map((w) => ({ page: w.page, rect: w.rect.map(Math.round) }))).toEqual([
      { page: 0, rect: [72, 660, 273, 681] },
    ])
    expect(by.notes).toMatchObject({ type: 'text', multiline: true })
    expect(by.agree).toMatchObject({ type: 'checkbox', value: false })
    expect(by.size).toMatchObject({ type: 'radio', value: null, options: ['S', 'M', 'L'] })
    expect(by.size!.widgets.map((w) => w.option)).toEqual(['S', 'M', 'L'])
    expect(by.country).toMatchObject({
      type: 'dropdown',
      options: ['Austria', 'Germany', 'Switzerland'],
      value: [],
    })
    expect(by.toppings).toMatchObject({ type: 'listbox', multiselect: true })
    expect(by.locked).toMatchObject({ type: 'text', value: 'Fixed', readOnly: true })
    expect(by.sign).toMatchObject({ type: 'signature', readOnly: true, signed: false })
  })

  it('fills every kind, with appearances other readers show', async () => {
    const out = await applyPdfEdits(
      { bytes: await makeFormPdf() },
      {
        fields: {
          name: 'Ada Lovelace',
          notes: 'Line one\nLine two',
          agree: true,
          size: 'M',
          country: 'Austria',
          toppings: ['Cheese', 'Olives'],
        },
      },
      ctx,
    )
    expect(out.warnings).toEqual([])
    const { form } = await readPdfContents({ bytes: out.bytes })
    const v = Object.fromEntries(form.fields.map((f) => [f.name, f.value]))
    expect(v).toMatchObject({
      name: 'Ada Lovelace',
      notes: 'Line one\nLine two',
      agree: true,
      size: 'M',
      country: ['Austria'],
      toppings: ['Cheese', 'Olives'],
    })
    expect(await valuesSeen(out.bytes)).toMatchObject({
      name: 'Ada Lovelace',
      agree: 'Yes',
      size: 'M',
    })
    // Appearances were drawn (no reader has to make them up).
    const doc = await PDFDocument.load(out.bytes)
    expect(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances'))).toBeUndefined()
    expect(
      doc.getForm().getTextField('name').acroField.getWidgets()[0]!.getNormalAppearance(),
    ).toBeDefined()
  })

  it('honours read-only, maximum length, options and signature fields', async () => {
    const bytes = await makeFormPdf()
    const fill = (fields: Record<string, string | boolean | string[]>) =>
      applyPdfEdits({ bytes }, { fields }, ctx)
    await expect(fill({ locked: 'x' })).rejects.toThrow('“locked” is read-only.')
    await expect(fill({ name: 'x'.repeat(21) })).rejects.toThrow(
      '“name” takes at most 20 characters.',
    )
    await expect(fill({ size: 'XL' })).rejects.toThrow('“size” has no option “XL”; it has S, M, L.')
    await expect(fill({ country: ['Austria', 'Germany'] })).rejects.toThrow(
      '“country” takes one option.',
    )
    await expect(fill({ sign: 'me' })).rejects.toThrow('“sign” is a signature field')
    await expect(fill({ nope: 'x' })).rejects.toThrow('This form has no field “nope”.')
    await expect(fill({ agree: 'yes' })).rejects.toThrow('“agree” is a checkbox')
  })

  it('says which required fields are still empty', async () => {
    const out = await applyPdfEdits(
      { bytes: await makeFormPdf() },
      { fields: { agree: true } },
      ctx,
    )
    expect(out.warnings).toEqual(['Required fields still empty: “name”.'])
  })

  it('asks the reader to draw what the standard font can’t, and says so', async () => {
    const out = await applyPdfEdits(
      { bytes: await makeFormPdf() },
      { fields: { name: '確認' } },
      ctx,
    )
    expect(out.warnings).toEqual([
      '“name” has characters the standard PDF font can’t draw; readers draw its value themselves.',
    ])
    const doc = await PDFDocument.load(out.bytes)
    expect(String(doc.getForm().acroForm.dict.get(PDFName.of('NeedAppearances')))).toBe('true')
    expect(
      (await readPdfContents({ bytes: out.bytes })).form.fields.find((f) => f.name === 'name')!
        .value,
    ).toBe('確認')
  })

  it('flattens only when asked, with a warning', async () => {
    const out = await applyPdfEdits(
      { bytes: await makeFormPdf() },
      { fields: { name: 'Ada' }, flatten: true },
      ctx,
    )
    expect(out.warnings[0]).toContain('flattened')
    const { form } = await readPdfContents({ bytes: out.bytes })
    expect(form.fields).toEqual([])
    const { extractText } = await import('./text')
    expect(await extractText(out.bytes)).toContain('Ada')
  })

  it('says an XFA-only form can’t be filled, and drops the XFA copy of a hybrid one with a warning', async () => {
    const xfaOnly = await makeFormPdf({ xfaOnly: true })
    expect((await readPdfContents({ bytes: xfaOnly })).form).toEqual({
      kind: 'xfa-only',
      fields: [],
    })
    await expect(applyPdfEdits({ bytes: xfaOnly }, { fields: { a: 'b' } }, ctx)).rejects.toThrow(
      XFA_ONLY_MESSAGE,
    )
    const hybrid = await makeFormPdf({ xfa: true })
    expect((await readPdfContents({ bytes: hybrid })).form.kind).toBe('hybrid')
    const out = await applyPdfEdits({ bytes: hybrid }, { fields: { name: 'Ada' } }, ctx)
    expect(out.warnings[0]).toContain('XFA copy of the form')
    expect((await readPdfContents({ bytes: out.bytes })).form.kind).toBe('acroform')
  })

  it('a PDF without a form has none to fill', async () => {
    const plain = await makePdf([{ lines: ['x'] }])
    expect((await readPdfContents({ bytes: plain })).form).toEqual({ kind: 'none', fields: [] })
    await expect(applyPdfEdits({ bytes: plain }, { fields: { a: 'b' } }, ctx)).rejects.toThrow(
      'This PDF has no form to fill.',
    )
  })
})
