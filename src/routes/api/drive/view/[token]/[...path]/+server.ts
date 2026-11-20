import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { DriveError, driveService, viewMimeFor } from '$lib/server/drive'
import { driveViewHeaders, driveViewScope } from '$lib/server/drive-view'

/**
 * GET a rendered HTML page or one of its files: /api/drive/view/<token>/<path>,
 * the path below the folder the HTML file sits in (a top-level file loads
 * only itself). Read as the person the token names, with Drive's own
 * access check; served sandboxed (driveViewHeaders).
 */
export const GET: RequestHandler = async (event) => {
  const scope = driveViewScope(event.params.token)
  if (!scope) error(403, 'This view link has expired. Open the file from Drive again.')
  if (event.locals.user?.id !== scope.userId) error(403, 'This view link belongs to someone else.')
  const actor = { kind: 'user', userId: scope.userId } as const
  const segments = event.params.path.split('/')
  const drive = await driveService()
  try {
    // The page itself by its id (works when the folder isn't shared with the reader); its files by path.
    const own = segments.length === 1 && segments[0] === scope.fileName
    if (!own && scope.folderId === null) throw new DriveError('not_found', 'A page at the top of a drive can load only itself.')
    const out = own ? await drive.readFile(actor, scope.fileId) : await drive.readAtPath(actor, scope.folderId!, segments)
    return new Response(out.bytes.slice().buffer as ArrayBuffer, {
      headers: {
        ...driveViewHeaders(event.url.origin, event.params.token),
        'content-type': viewMimeFor(out.file.name),
        'content-length': String(out.bytes.byteLength),
      },
    })
  } catch (err) {
    if (err instanceof DriveError) error(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400, err.message)
    throw err
  }
}
