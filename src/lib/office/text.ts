import type { OfficeKind } from './kinds'

/**
 * An office file's text for agents and the Brain (`drive.read`): structure
 * kept as Markdown where the format has it (headings, lists, tables, one
 * section per page/slide). Each format implements `extractText` in its own
 * folder (`./pdf/text.ts`, `./docx/text.ts`, `./pptx/text.ts`, `./xlsx/text.ts`), loaded only
 * when needed. A format without it throws OfficeNotSupportedError. The
 * spreadsheets that are not OOXML (.xls, .ods) are converted first and read
 * as the .xlsx they convert to (./xlsx/convert.ts).
 */
export async function extractOfficeText(kind: OfficeKind, bytes: Uint8Array): Promise<string> {
  if (kind === 'xls' || kind === 'ods') {
    const [{ convertToXlsx }, xlsx] = await Promise.all([
      import('./xlsx/convert'),
      import('./xlsx/text'),
    ])
    return xlsx.extractText((await convertToXlsx(kind, bytes)).bytes)
  }
  const format =
    kind === 'pdf'
      ? await import('./pdf/text')
      : kind === 'docx'
        ? await import('./docx/text')
        : kind === 'pptx'
          ? await import('./pptx/text')
          : await import('./xlsx/text')
  return format.extractText(bytes)
}
