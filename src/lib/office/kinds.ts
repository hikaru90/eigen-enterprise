/**
 * The office formats the Drive opens with its own viewers and editors
 * (plan/phase-office-files.md): PDF, Word (.docx), PowerPoint (.pptx), Excel
 * (.xlsx, and the macro-enabled .xlsm, which is the same SpreadsheetML and
 * opens as `xlsx`), and — read-only, through a conversion — the spreadsheet
 * formats that are not OOXML: Excel 97–2003 (.xls) and OpenDocument (.ods).
 * Shared by the browser (viewers) and the server (saves, text for agents).
 */

export type OfficeKind = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'xls' | 'ods'

export const OFFICE_KINDS: readonly OfficeKind[] = ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'ods']

export const isOfficeKind = (kind: string): kind is OfficeKind =>
  (OFFICE_KINDS as readonly string[]).includes(kind)

/** Formats shown through a conversion and never saved in place (an editable .xlsx copy is made instead). */
export const READ_ONLY_OFFICE_KINDS: readonly OfficeKind[] = ['xls', 'ods']

/** A macro-enabled Excel workbook (.xlsm): edited like .xlsx, its VBA project kept byte for byte and never run. */
export const XLSM_MIME = 'application/vnd.ms-excel.sheet.macroEnabled.12'

export const OFFICE_MIME: Record<OfficeKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
}

/** How people call the format in sentences ("not a PDF", "PowerPoint … not supported yet"). */
export const OFFICE_LABEL: Record<OfficeKind, string> = {
  pdf: 'PDF',
  docx: 'Word document',
  pptx: 'PowerPoint deck',
  xlsx: 'Excel workbook',
  xls: 'Excel 97–2003 workbook',
  ods: 'OpenDocument spreadsheet',
}

/**
 * Whether `bytes` start like a file of this format: "%PDF-" (ISO 32000
 * §7.5.2), the Compound File header of a BIFF .xls ([MS-CFB] §2.2), or a
 * ZIP local file header (OPC packages, ECMA-376 Part 2; ODF packages). A
 * format fact that keeps a viewer from saving garbage under the wrong name;
 * the parsers do the real validation.
 */
export function hasOfficeSignature(kind: OfficeKind, bytes: Uint8Array): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b)
  if (kind === 'pdf') return starts([0x25, 0x50, 0x44, 0x46, 0x2d])
  if (kind === 'xls') return starts([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  return starts([0x50, 0x4b, 0x03, 0x04])
}

/** A format that can't do `what` yet (its milestone has not landed). Thrown, never swallowed. */
export class OfficeNotSupportedError extends Error {
  constructor(
    readonly kind: OfficeKind,
    readonly what: string,
  ) {
    super(`${OFFICE_LABEL[kind]}: ${what} is not supported yet.`)
    this.name = 'OfficeNotSupportedError'
  }
}
