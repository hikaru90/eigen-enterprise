import { z } from 'zod'
import { FOLDERS, type Folder } from './types'

/**
 * The Inbox page's state lives in its URL (S4):
 * `?box=<mailboxId>&folder=<folder>&q=<search>&m=<messageId>&images=1`.
 * Shared by the server load and the page (no server imports here).
 */

export type InboxState = { box: string | null; folder: Folder | null; q: string | null; m: string | null; images: boolean }

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
  const q = params.get('q')?.trim() ?? ''
  return {
    ok: true,
    state: { box, folder: folder as Folder | null, q: q === '' ? null : q, m, images: params.get('images') === '1' },
  }
}

/** `base` is the resolved page path (resolve('/m/email/inbox')). */
export function inboxHref(base: string, s: Partial<InboxState>): string {
  const p = new URLSearchParams()
  if (s.box) p.set('box', s.box)
  if (s.folder) p.set('folder', s.folder)
  if (s.q) p.set('q', s.q)
  if (s.m) p.set('m', s.m)
  if (s.images) p.set('images', '1')
  const qs = p.toString()
  return qs ? `${base}?${qs}` : base
}
