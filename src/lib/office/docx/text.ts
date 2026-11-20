import { OfficeNotSupportedError } from '../kinds'

/** The file's text as Markdown (see ../text.ts). Lands with this format's first milestone (plan/phase-office-files.md). */
export async function extractText(bytes: Uint8Array): Promise<string> {
  void bytes
  throw new OfficeNotSupportedError('docx', 'reading text')
}
