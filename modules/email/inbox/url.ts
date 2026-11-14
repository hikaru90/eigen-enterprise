import { z } from 'zod'
import { COMPOSE_MODES, FOLDERS, LIST_FILTERS, type ComposeMode, type Folder, type ListFilter } from './types'

/**
 * The Inbox page's state lives in its URL (S4):
 * `?box=<mailboxId>&folder=<folder>&q=<search>&m=<messageId>&images=1`, and
 * (S5) `compose=new|reply|replyAll|forward` (a reply or forward is of `m`) and
 * `sent=1` (the "Sent" confirmation after sending).
 * Organising (2026-11-14): `view=starred` or `label=<labelId>` instead of a folder (both span every
 * folder but Spam and Trash), `filter=unread|attachments`, `sort=oldest` (newest is the default).
 * Shared by the server load and the page (no server imports here).
 */

export type InboxState = {
  box: string | null
  folder: Folder | null
  q: string | null
  m: string | null
  images: boolean
  compose: ComposeMode | null
  sent: boolean
  view: 'starred' | null
  label: string | null
  filter: ListFilter | null
  sort: 'oldest' | null
}

const uuid = z.string().uuid()

/** Mailbox, mail and attachment ids are uuids; anything else is "not found" before it reaches Postgres. */
export const isUuid = (v: string): boolean => uuid.safeParse(v).success

export function parseInboxQuery(params: URLSearchParams): { ok: true; state: InboxState } | { ok: false } {
  const box = params.get('box')
  const m = params.get('m')
  const folder = params.get('folder')
  if (box !== null && !uuid.safeParse(box).success) return { ok: false }
  if (m !== null && !uuid.safeParse(m).success) return { ok: false }
  if (folder !== null && !(FOLDERS as readonly string[]).includes(folder)) return { ok: false }
  const compose = params.get('compose')
  if (compose !== null && !(COMPOSE_MODES as readonly string[]).includes(compose)) return { ok: false }
  // A reply or forward is of the opened mail.
  if (compose !== null && compose !== 'new' && m === null) return { ok: false }
  const view = params.get('view')
  if (view !== null && view !== 'starred') return { ok: false }
  const label = params.get('label')
  if (label !== null && !uuid.safeParse(label).success) return { ok: false }
  // One place at a time: a folder, Starred, or a label.
  if ([folder, view, label].filter((v) => v !== null).length > 1) return { ok: false }
  const filter = params.get('filter')
  if (filter !== null && !(LIST_FILTERS as readonly string[]).includes(filter)) return { ok: false }
  const sort = params.get('sort')
  if (sort !== null && sort !== 'oldest') return { ok: false }
  const q = params.get('q')?.trim() ?? ''
  return {
    ok: true,
    state: {
      box,
      folder: folder as Folder | null,
      q: q === '' ? null : q,
      m,
      images: params.get('images') === '1',
      compose: compose as ComposeMode | null,
      sent: params.get('sent') === '1',
      view: view as 'starred' | null,
      label,
      filter: filter as ListFilter | null,
      sort: sort as 'oldest' | null,
    },
  }
}

/** `base` is the resolved page path (resolve('/m/email/inbox')). */
export function inboxHref(base: string, s: Partial<InboxState>): string {
  const p = new URLSearchParams()
  if (s.box) p.set('box', s.box)
  if (s.folder) p.set('folder', s.folder)
  if (s.view) p.set('view', s.view)
  if (s.label) p.set('label', s.label)
  if (s.filter) p.set('filter', s.filter)
  if (s.sort) p.set('sort', s.sort)
  if (s.q) p.set('q', s.q)
  if (s.m) p.set('m', s.m)
  if (s.images) p.set('images', '1')
  if (s.compose) p.set('compose', s.compose)
  if (s.sent) p.set('sent', '1')
  const qs = p.toString()
  return qs ? `${base}?${qs}` : base
}
