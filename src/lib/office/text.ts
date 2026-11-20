import type { OfficeKind } from './kinds'

/**
 * An office file's text for agents and the Brain (`drive.read`): structure
 * kept as Markdown where the format has it (headings, lists, tables, one
 * section per page/slide). Each format implements `extractText` in its own
 * folder (`./pdf/text.ts`, `./docx/text.ts`, `./pptx/text.ts`), loaded only
 * when needed. A format without it throws OfficeNotSupportedError.
 */
export async function extractOfficeText(kind: OfficeKind, bytes: Uint8Array): Promise<string> {
  const format =
    kind === 'pdf' ? await import('./pdf/text') : kind === 'docx' ? await import('./docx/text') : await import('./pptx/text')
  return format.extractText(bytes)
}
