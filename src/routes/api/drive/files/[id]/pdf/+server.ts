import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { OpcError } from '$lib/office/ooxml/package'
import { createSheetEditor } from '$lib/office/xlsx/editor'
import { PAPER_SIZES } from '$lib/office/xlsx/print'
import { exportWorkbookPdf, PdfBrowserUnavailableError } from '$lib/office/xlsx/print-pdf'
import { XlsxRefError } from '$lib/office/xlsx/ref'
import { XlsxError } from '$lib/office/xlsx/workbook'
import {
  DRIVE_STATUS,
  DriveError,
  driveAttempted,
  driveErrorReport,
  driveService,
  officeKind,
  requestActor,
} from '$lib/server/drive'

const pdfBody = z
  .object({
    sheet: z.string().min(1).max(31).optional(),
    locale: z.enum(['en', 'de']).optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    paperSize: z.enum(PAPER_SIZES).optional(),
    fitToWidth: z.number().int().min(0).max(99).nullable().optional(),
    printGridlines: z.boolean().optional(),
    printHeadings: z.boolean().optional(),
  })
  .strict()

function failResponse(
  event: Parameters<RequestHandler>[0],
  err: DriveError,
  input: unknown,
): Response {
  return json(
    driveErrorReport(err, {
      attempted: driveAttempted(event),
      tool: 'drive.sheet_export_pdf',
      input,
    }),
    { status: DRIVE_STATUS[err.code] },
  )
}

/**
 * POST { sheet?, locale?, orientation?, paperSize?, fitToWidth?, printGridlines?, printHeadings? }:
 * renders the workbook (or one worksheet) to a paginated PDF via headless Chromium
 * (= `drive.sheet_export_pdf`). Saves nothing.
 */
export const POST: RequestHandler = async (event) => {
  const actor = requestActor(event)
  let parsedInput: z.infer<typeof pdfBody> = {}
  try {
    const raw = await event.request.text()
    let jsonBody: unknown = {}
    if (raw.trim() !== '') {
      try {
        jsonBody = JSON.parse(raw)
      } catch {
        throw new DriveError('invalid', 'The request body is not valid JSON.')
      }
    }
    const parsed = pdfBody.safeParse(jsonBody)
    if (!parsed.success)
      throw new DriveError(
        'invalid',
        parsed.error.issues[0]?.message ?? 'Invalid PDF export options.',
      )
    parsedInput = parsed.data

    const drive = await driveService()
    const { file, bytes } = await drive.readFile(actor, event.params.id)
    if (officeKind(file.name, file.mime) !== 'xlsx')
      throw new DriveError('invalid', `“${file.name}” is not an Excel workbook (.xlsx).`)

    const editor = createSheetEditor(bytes)
    const hasOverride =
      parsedInput.orientation !== undefined ||
      parsedInput.paperSize !== undefined ||
      parsedInput.fitToWidth !== undefined ||
      parsedInput.printGridlines !== undefined ||
      parsedInput.printHeadings !== undefined
    if (hasOverride) {
      const targets = parsedInput.sheet
        ? [editor.wb.requireWorksheet(parsedInput.sheet).name]
        : editor.wb
            .sheets()
            .filter((s) => s.kind === 'worksheet' && s.state === 'visible')
            .map((s) => s.name)
      for (const sName of targets) {
        editor.apply({
          op: 'set_page_setup',
          sheet: sName,
          ...(parsedInput.orientation !== undefined
            ? { orientation: parsedInput.orientation }
            : {}),
          ...(parsedInput.paperSize !== undefined ? { paperSize: parsedInput.paperSize } : {}),
          ...(parsedInput.fitToWidth !== undefined ? { fitToWidth: parsedInput.fitToWidth } : {}),
          ...(parsedInput.printGridlines !== undefined
            ? { printGridlines: parsedInput.printGridlines }
            : {}),
          ...(parsedInput.printHeadings !== undefined
            ? { printHeadings: parsedInput.printHeadings }
            : {}),
        })
      }
    }

    const exported = await exportWorkbookPdf(editor, file.name, {
      ...(parsedInput.sheet ? { sheet: parsedInput.sheet } : {}),
      ...(parsedInput.locale ? { locale: parsedInput.locale } : {}),
    })

    return new Response(Buffer.from(exported.bytes), {
      headers: {
        'content-type': exported.mime,
        'content-length': String(exported.sizeBytes),
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof PdfBrowserUnavailableError)
      return failResponse(
        event,
        new DriveError('unavailable', err.message, undefined, { cause: err }),
        parsedInput,
      )
    if (err instanceof XlsxError || err instanceof XlsxRefError)
      return failResponse(
        event,
        new DriveError('invalid', err.message, undefined, { cause: err }),
        parsedInput,
      )
    if (err instanceof OpcError)
      return failResponse(
        event,
        new DriveError('invalid', `The workbook could not be read: ${err.message}`, undefined, {
          cause: err,
        }),
        parsedInput,
      )
    if (err instanceof DriveError) return failResponse(event, err, parsedInput)
    throw err
  }
}
