import type { MailPerson } from '../store'
import type { Folder, LabelColor, MoveTarget } from '../types'

/** Small view helpers for the Inbox page (client-safe). */

/** Where the opened mail can go from the folder it is in, in button order. */
export function moveActions(folder: Folder): Array<{ folder: MoveTarget; label: string }> {
  switch (folder) {
    case 'inbox':
      return [
        { folder: 'archive', label: 'Archive' },
        { folder: 'spam', label: 'Spam' },
        { folder: 'trash', label: 'Trash' },
      ]
    case 'archive':
      return [
        { folder: 'inbox', label: 'Back to inbox' },
        { folder: 'spam', label: 'Spam' },
        { folder: 'trash', label: 'Trash' },
      ]
    case 'spam':
      return [
        { folder: 'inbox', label: 'Not spam' },
        { folder: 'trash', label: 'Trash' },
      ]
    case 'trash':
      return [{ folder: 'inbox', label: 'Back to inbox' }]
    case 'sent':
      return [{ folder: 'trash', label: 'Trash' }]
  }
}

export function personLabel(p: MailPerson): string {
  return p.name ?? p.address
}

export function personFull(p: MailPerson): string {
  return p.name ? `${p.name} <${p.address}>` : p.address
}

/** The list's time column: the time today, the day this year, the date before. */
export function shortWhen(iso: string, now: Date, locale?: string): string {
  const d = new Date(iso)
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function fullWhen(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Label colours: the board's muted grounds plus its one coral accent (fixed in light and dark mode). */
const LABEL_DOTS: Record<LabelColor, string> = {
  slate: '#3f4f66',
  stone: '#767676',
  sage: '#6f8a6a',
  sky: '#6e8fb0',
  sand: '#b39a6b',
  coral: 'var(--tone-coral)',
}

export const LABEL_COLOR_NAMES: Record<LabelColor, string> = {
  slate: 'Slate',
  stone: 'Stone',
  sage: 'Sage',
  sky: 'Sky',
  sand: 'Sand',
  coral: 'Coral',
}

export function labelDot(color: LabelColor): string {
  return LABEL_DOTS[color]
}
