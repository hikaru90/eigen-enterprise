/**
 * The office formats the Drive opens with its own viewers and editors
 * (plan/phase-office-files.md): PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx).
 * Shared by the browser (viewers) and the server (saves, text for agents).
 */

export type OfficeKind = 'pdf' | 'docx' | 'pptx' | 'xlsx'

export const OFFICE_KINDS: readonly OfficeKind[] = ['pdf', 'docx', 'pptx', 'xlsx']

export const OFFICE_MIME: Record<OfficeKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}

/** How people call the format in sentences ("not a PDF", "PowerPoint … not supported yet"). */
export const OFFICE_LABEL: Record<OfficeKind, string> = { pdf: 'PDF', docx: 'Word document', pptx: 'PowerPoint deck', xlsx: 'Excel workbook' }

/**
 * Whether `bytes` start like a file of this format: "%PDF-" (ISO 32000
 * §7.5.2) or a ZIP local file header (OPC packages, ECMA-376 Part 2). A
 * format fact that keeps a viewer from saving garbage under the wrong name;
 * the parsers do the real validation.
 */
export function hasOfficeSignature(kind: OfficeKind, bytes: Uint8Array): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b)
  return kind === 'pdf' ? starts([0x25, 0x50, 0x44, 0x46, 0x2d]) : starts([0x50, 0x4b, 0x03, 0x04])
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
