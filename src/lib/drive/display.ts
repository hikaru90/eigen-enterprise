import type { DriveItem } from './api'
import { OFFICE_MIME } from '$lib/office/kinds'

/** How a Drive row looks: folder, document (.md/.txt), table (.csv), image, PDF, Word (.docx), slides (.pptx), or any other file. */
export type DriveItemKind = 'folder' | 'document' | 'table' | 'image' | 'pdf' | 'word' | 'slides' | 'sheet' | 'file'

/** The item's kind from its type, file extension and MIME type (same rules as the old row icons). */
export function driveItemKind(item: Pick<DriveItem, 'type' | 'name' | 'mime'>): DriveItemKind {
  if (item.type === 'folder') return 'folder'
  const n = item.name.toLowerCase()
  if (n.endsWith('.md') || n.endsWith('.txt')) return 'document'
  if (n.endsWith('.csv')) return 'table'
  if (item.mime?.startsWith('image/')) return 'image'
  if (item.mime === OFFICE_MIME.pdf || n.endsWith('.pdf')) return 'pdf'
  if (item.mime === OFFICE_MIME.docx || n.endsWith('.docx')) return 'word'
  if (item.mime === OFFICE_MIME.pptx || n.endsWith('.pptx')) return 'slides'
  if (item.mime === OFFICE_MIME.xlsx || n.endsWith('.xlsx')) return 'sheet'
  return 'file'
}

/**
 * Whether a row shows the file's own picture (list tile, grid card): raster
 * images. SVG keeps its icon — the content endpoint serves it as text, never
 * as active content.
 */
export function hasThumbnail(item: Pick<DriveItem, 'type' | 'name' | 'mime'>): boolean {
  return driveItemKind(item) === 'image' && item.mime !== 'image/svg+xml'
}

/** Plain-text formats a card shows the opening of (beyond .md/.txt and .csv). */
const TEXT_PREVIEW_EXT = new Set(['markdown', 'log', 'json', 'yaml', 'yml', 'xml', 'tsv', 'ini', 'toml'])
/** Above this a card keeps its icon: the preview would load the whole file. */
export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024

/**
 * How a grid card previews a file's text: 'table' (CSV: the first rows),
 * 'text' (the opening lines), or null (no text preview: not a text format,
 * or too large to load for a glance). A format fact by extension.
 */
export function textPreviewOf(item: Pick<DriveItem, 'type' | 'name' | 'mime' | 'size'>): 'text' | 'table' | null {
  if (item.type !== 'file') return null
  if ((item.size ?? 0) > TEXT_PREVIEW_MAX_BYTES) return null
  const kind = driveItemKind(item)
  if (kind === 'table') return 'table'
  if (kind === 'document') return 'text'
  const dot = item.name.lastIndexOf('.')
  const ext = dot > 0 ? item.name.slice(dot + 1).toLowerCase() : ''
  return TEXT_PREVIEW_EXT.has(ext) ? 'text' : null
}

/** Up to two initials for an owner avatar ("Ada Owner" → "AO", "ada" → "A"). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts
    .slice(0, 2)
    .map((p) => [...p][0]!.toUpperCase())
    .join('')
}

/** "Today 14:05", "Yesterday", or a short date — the Modified column. */
export function shortWhen(at: string | Date, now: Date = new Date()): string {
  const d = new Date(at)
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000)
  if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (diffDays === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

const DATED_KIND = { taken: 'Taken', created: 'Created', uploaded: 'Uploaded', added: 'Added' } as const

/**
 * When a file is from, to the month (Contribute `0c945439`): "Mar 2019" plus
 * the kind of date — taken / created (what the file records about itself) or
 * uploaded / added (when it reached the Drive). A recorded date is its own
 * wall clock stored as UTC, so it is read in UTC; an upload in local time.
 */
export function datedLabel(dated: NonNullable<DriveItem['dated']>): {
  month: string
  kind: NonNullable<DriveItem['dated']>['kind']
  full: string
} {
  const at = new Date(dated.at)
  const timeZone = dated.kind === 'taken' || dated.kind === 'created' ? 'UTC' : undefined
  const month = at.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone })
  const long = at.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone })
  return { month, kind: dated.kind, full: `${DATED_KIND[dated.kind]} ${long}` }
}
