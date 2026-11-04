import type { DriveItem } from './api'

/** How a Drive row looks: folder, document (.md/.txt), table (.csv), image, PDF, or any other file. */
export type DriveItemKind = 'folder' | 'document' | 'table' | 'image' | 'pdf' | 'file'

/** The item's kind from its type, file extension and MIME type (same rules as the old row icons). */
export function driveItemKind(item: Pick<DriveItem, 'type' | 'name' | 'mime'>): DriveItemKind {
  if (item.type === 'folder') return 'folder'
  const n = item.name.toLowerCase()
  if (n.endsWith('.md') || n.endsWith('.txt')) return 'document'
  if (n.endsWith('.csv')) return 'table'
  if (item.mime?.startsWith('image/')) return 'image'
  if (item.mime === 'application/pdf' || n.endsWith('.pdf')) return 'pdf'
  return 'file'
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
