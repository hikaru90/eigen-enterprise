import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'
import { DriveError, driveJson, driveService, previewKind, requestActor } from '$lib/server/drive'

/**
 * GET the file's bytes; PUT new bytes into a PDF, Word or PowerPoint file
 * (the raw body, ?session= the editor session holding the edit lock, W-6;
 * without it the file must not be locked). Saved as a revision.
 *
 * ?revision=<id>: that earlier version's bytes, as a download named
 * "<name> (version 2026-11-20 14-05).<ext>".
 *
 * The file's bytes: inline for the preview (images, PDF in the browser's
 * viewer), as an attachment with ?download=1. Markdown/HTML/SVG are never
 * served inline as active content: nosniff + a sandboxing CSP (except
 * the inline PDF, which the browser's own viewer renders).
 */
export const GET: RequestHandler = async (event) => {
  const actor = requestActor(event)
  try {
    const revisionId = event.url.searchParams.get('revision')
    const drive = await driveService()
    // ?revision=<id>: an earlier version, always as a download named after its time.
    const { file, bytes, versionName } = revisionId
      ? await drive
          .readRevisionBytes(actor, event.params.id, revisionId)
          .then((r) => ({ ...r, versionName: versionFileName(r.file.name, r.revision.createdAt) }))
      : { ...(await drive.readFile(actor, event.params.id)), versionName: null }
    const download = versionName !== null || event.url.searchParams.get('download') === '1'
    const kind = previewKind(file.name, file.mime)
    const inline =
      !download && (kind === 'image' || kind === 'pdf') && file.mime !== 'image/svg+xml'
    const type = inline ? file.mime : download ? file.mime : 'text/plain; charset=utf-8'
    const name = encodeURIComponent(versionName ?? file.name)
    return new Response(bytes.slice().buffer as ArrayBuffer, {
      headers: {
        'content-type': type,
        'content-length': String(bytes.byteLength),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`,
        'x-content-type-options': 'nosniff',
        // Chrome's PDF viewer refuses a sandboxed document; everything else is sandboxed.
        ...(kind === 'pdf' && inline
          ? {}
          : {
              'content-security-policy':
                "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
            }),
        'cache-control': 'private, no-store',
      },
    })
  } catch (err) {
    if (err instanceof DriveError)
      error(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400, err.message)
    throw err
  }
}

/** "plan.pdf" + its time → "plan (version 2026-11-20 14-05).pdf" (UTC). */
function versionFileName(name: string, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
  const dot = name.lastIndexOf('.')
  return dot > 0
    ? `${name.slice(0, dot)} (version ${stamp})${name.slice(dot)}`
    : `${name} (version ${stamp})`
}

const session = z.string().min(8).max(100)

export const PUT: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    const raw = event.url.searchParams.get('session')
    const s = raw === null ? undefined : session.safeParse(raw)
    if (s && !s.success)
      throw new DriveError('invalid', 'session: the editor session id is 8–100 characters.')
    const bytes = new Uint8Array(await event.request.arrayBuffer())
    return (await driveService()).writeBytes(actor, event.params.id, bytes, s?.data)
  })
