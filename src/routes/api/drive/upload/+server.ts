import type { RequestHandler } from './$types'
import { DriveError, driveJson, driveService, requestActor, type ItemView } from '$lib/server/drive'

/**
 * Upload one or more files (multipart: folderId, file × n). Each file is
 * checked on its own: the ones that fit land, each refusal comes back as a
 * plain sentence ("“x.zip” is 120 MB; files can be at most 100 MB.").
 */
export const POST: RequestHandler = (event) =>
  driveJson(async () => {
    const actor = requestActor(event)
    let form: FormData
    try {
      form = await event.request.formData()
    } catch {
      throw new DriveError('invalid', 'Send the files as a multipart form.')
    }
    const folderId = form.get('folderId')?.toString() || null
    const files = form.getAll('file').filter((f): f is File => f instanceof File)
    if (files.length === 0) throw new DriveError('invalid', 'Choose at least one file.')
    const drive = await driveService()
    const uploaded: ItemView[] = []
    const errors: string[] = []
    for (const file of files) {
      try {
        uploaded.push(await drive.upload(actor, folderId, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type }))
      } catch (err) {
        // Access refusals stop the whole request (fail closed); size/name problems are per file.
        if (err instanceof DriveError && (err.code === 'too_large' || err.code === 'invalid')) errors.push(err.message)
        else throw err
      }
    }
    return { uploaded, errors }
  })
