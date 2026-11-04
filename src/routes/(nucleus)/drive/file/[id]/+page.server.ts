import type { PageServerLoad } from './$types'
import {
  driveService,
  drivePage,
  isRevisioned,
  LOCK_HEARTBEAT_MS,
  parseCsv,
  previewKind,
  renderDriveMarkdown,
  requestActor,
} from '$lib/server/drive'

/** CSV previews show at most this many rows (the full file downloads). */
const CSV_PREVIEW_ROWS = 500
/** Text previews show at most this many characters. */
const TEXT_PREVIEW_CHARS = 200_000

/**
 * Open a file (/drive/file/[id]). People who may edit a Markdown/CSV file
 * get the in-place editor (D2: `content` is its text); everyone else the
 * preview: Markdown rendered and sanitized server side, CSV parsed into a
 * table, images and PDF from the content endpoint, else a download.
 * Revisions for Markdown/CSV are listed with their authors.
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
    let content: string | null = null
    if (kind === 'markdown' || kind === 'csv' || kind === 'text') {
      content = (await drive.readText(actor, event.params.id)).content
      if (kind === 'markdown') html = renderDriveMarkdown(content)
      else if (kind === 'csv') {
        const rows = parseCsv(content)
        table = { rows: rows.slice(0, CSV_PREVIEW_ROWS), truncated: rows.length > CSV_PREVIEW_ROWS }
      } else text = content.slice(0, TEXT_PREVIEW_CHARS)
    }
    const revisions = isRevisioned(info.file.name)
      ? await drive.listRevisions(actor, event.params.id)
      : []
    const people = isRevisioned(info.file.name) ? (await drive.shareTargets()).people : []
    const authors = Object.fromEntries(people.map((p) => [p.id, p.name || p.email]))
    const editable =
      info.canEdit && isRevisioned(info.file.name) && (kind === 'markdown' || kind === 'csv')
    // The side panel's owner and sharing state (same rules as the listings).
    const described = (await drive.describeItems(actor, [info.file]))[`file:${info.file.id}`]!
    return {
      ...info,
      kind,
      html,
      text,
      table,
      revisions,
      authors,
      editable,
      content: editable ? content : null,
      heartbeatMs: LOCK_HEARTBEAT_MS,
      described,
    }
  })
}
