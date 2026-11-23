import type { RequestHandler } from './$types'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { error } from '@sveltejs/kit'
import { requireCapability } from '$lib/server/auth/require-capability'
import { exportFile, liveExportPort } from '$lib/server/export/company/live'

/**
 * Downloads a finished company export (Settings → Export, kernel.export_status's
 * downloadPath). Owner only, signed in; streamed from disk, never held in memory.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
  await requireCapability(locals, 'export.manage', 'Only the owner can download a company export.')
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) error(404, 'No such export.')
  const view = await liveExportPort.get(params.id)
  if (!view?.downloadPath) error(404, view ? `This export is ${view.status}; there is nothing to download.` : 'No such export.')
  const day = view.createdAt.slice(0, 10)
  const body = Readable.toWeb(createReadStream(exportFile(params.id))) as ReadableStream<Uint8Array>
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="company-export-${day}.zip"`,
      ...(view.bytes !== null ? { 'content-length': String(view.bytes) } : {}),
      'cache-control': 'no-store',
    },
  })
}
