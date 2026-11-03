import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { DriveError, driveService, previewKind, requestActor } from '$lib/server/drive'

/**
 * The file's bytes: inline for the preview (images, PDF in the browser's
 * viewer), as an attachment with ?download=1. Markdown/HTML/SVG are never
 * served inline as active content: nosniff + a sandboxing CSP (except
 * the inline PDF, which the browser's own viewer renders).
 */
export const GET: RequestHandler = async (event) => {
  const actor = requestActor(event)
  try {
    const { file, bytes } = await (await driveService()).readFile(actor, event.params.id)
    const download = event.url.searchParams.get('download') === '1'
    const kind = previewKind(file.name, file.mime)
    const inline = !download && (kind === 'image' || kind === 'pdf') && file.mime !== 'image/svg+xml'
    const type = inline ? file.mime : download ? file.mime : 'text/plain; charset=utf-8'
    const name = encodeURIComponent(file.name)
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        'content-type': type,
        'content-length': String(bytes.byteLength),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
        'x-content-type-options': 'nosniff',
        // Chrome's PDF viewer refuses a sandboxed document; everything else is sandboxed.
        ...(kind === 'pdf' && inline ? {} : { 'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DriveError) error(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400, err.message)
    throw err
  }
}
