import type { RequestHandler } from './$types'
import {
  DriveError,
  driveJson,
  driveService,
  ON_CONFLICT,
  requestActor,
  UploadConflictError,
  type ItemView,
  type OnConflict,
  type UploadOutcome,
} from '$lib/server/drive'

/**
 * Upload one or more files (multipart: folderId, onConflict, file × n). Each
 * file is checked on its own: the ones that fit land, each refusal comes back
 * as a plain sentence ("“x.zip” is 120 MB; files can be at most 100 MB.").
 * `onConflict` (required, as drive.upload's on_conflict) says what happens
 * when a file of that exact name is already in the folder; under `fail` each
 * clash comes back in `conflicts` with the file that is there, so the page
 * can ask and send that file again with replace or keep_both.
 */
export const POST: RequestHandler = (event) =>
  driveJson(event, async () => {
    const actor = requestActor(event)
    let form: FormData
    try {
      form = await event.request.formData()
    } catch {
      throw new DriveError('invalid', 'Send the files as a multipart form.')
    }
    const folderId = form.get('folderId')?.toString() || null
    const onConflict = form.get('onConflict')?.toString()
    if (!(ON_CONFLICT as readonly string[]).includes(onConflict ?? ''))
      throw new DriveError(
        'invalid',
        'Say what to do when a file of that name is already there: onConflict replace, keep_both or fail.',
      )
    const files = form.getAll('file').filter((f): f is File => f instanceof File)
    if (files.length === 0) throw new DriveError('invalid', 'Choose at least one file.')
    const drive = await driveService()
    const uploaded: Array<ItemView & { outcome: UploadOutcome }> = []
    const errors: string[] = []
    const conflicts: Array<{ name: string; error: string; existing: ItemView }> = []
    for (const file of files) {
      try {
        uploaded.push(
          await drive.upload(
            actor,
            folderId,
            { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type },
            onConflict as OnConflict,
          ),
        )
      } catch (err) {
        // Access refusals stop the whole request (fail closed); size/name problems and clashes are per file.
        if (err instanceof UploadConflictError)
          conflicts.push({ name: file.name, error: err.message, existing: err.existing })
        else if (err instanceof DriveError && (err.code === 'too_large' || err.code === 'invalid'))
          errors.push(err.message)
        else throw err
      }
    }
    return { uploaded, errors, conflicts }
  })
