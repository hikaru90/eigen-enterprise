import { OFFICE_MIME } from '$lib/office/kinds'

/**
 * The MIME type by extension, copied from Drive's `MIME_BY_EXT` in
 * modules/drive/preview.ts (modules never import each other, and Drive does
 * not export it). Keep the two in step: a copied file should get the type
 * Drive would give the same name.
 */
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  md: 'text/markdown',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  pdf: OFFICE_MIME.pdf,
  docx: OFFICE_MIME.docx,
  pptx: OFFICE_MIME.pptx,
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** As Drive's `extensionOf`: the text after the last dot (not a leading one), lower-cased. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}
