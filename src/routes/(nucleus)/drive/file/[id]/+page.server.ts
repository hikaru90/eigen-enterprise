import type { PageServerLoad } from './$types'
import { driveService, drivePage, isRevisioned, parseCsv, previewKind, renderDriveMarkdown, requestActor } from '$lib/server/drive'

/** CSV previews show at most this many rows (the full file downloads). */
const CSV_PREVIEW_ROWS = 500
/** Text previews show at most this many characters. */
const TEXT_PREVIEW_CHARS = 200_000

/**
 * Open a file (/drive/file/[id]): the preview now, the in-place editor in D2.
 * Markdown is rendered and sanitized server side, CSV parsed into a table,
 * images and PDF come from the content endpoint, everything else offers a
 * download. Revisions for Markdown/CSV are listed.
 */
export const load: PageServerLoad = async (event) => {
  const actor = requestActor(event)
  const drive = await driveService()
  return drivePage(async () => {
    const info = await drive.fileInfo(actor, event.params.id)
    const kind = previewKind(info.file.name, info.file.mime ?? '')
    let html: string | null = null
    let text: string | null = null
    let table: { rows: string[][]; truncated: boolean } | null = null
    if (kind === 'markdown' || kind === 'csv' || kind === 'text') {
      const content = (await drive.readText(actor, event.params.id)).content
      if (kind === 'markdown') html = renderDriveMarkdown(content)
      else if (kind === 'csv') {
        const rows = parseCsv(content)
        table = { rows: rows.slice(0, CSV_PREVIEW_ROWS), truncated: rows.length > CSV_PREVIEW_ROWS }
      } else text = content.slice(0, TEXT_PREVIEW_CHARS)
    }
    const revisions = isRevisioned(info.file.name) ? await drive.listRevisions(actor, event.params.id) : []
    const people = revisions.length > 0 ? (await drive.shareTargets()).people : []
    const authors = Object.fromEntries(people.map((p) => [p.id, p.name || p.email]))
    return { ...info, kind, html, text, table, revisions, authors }
  })
}
