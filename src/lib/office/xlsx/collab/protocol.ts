import type { SheetOp } from '../ops'
import { transform, transformLists } from './transform'

/**
 * Co-editing a workbook (plan/phase-office-files.md §7.4): what travels
 * between the grids, the agent's sheet tools and the server's op log of an
 * open file. Shared by the browser and the server.
 *
 * The server keeps one log per file: entries numbered 1, 2, 3 … in the order
 * it accepted them. Every replica (each open grid, the server's own copy)
 * starts from the same saved file and applies the entries after its `seq`
 * in that order, so all of them hold the same workbook. A client sends what
 * it changed with the last `seq` it had; the server rewrites (transforms)
 * the batch past whatever came in meanwhile, checks it applies, and logs it.
 */

/** Part images (an undo restores them), base64 bytes. */
export type WireImages = Record<
  string,
  { exists: false } | { exists: true; contentType: string; data: string }
>

/** One change: operations applied in order, all or none. */
export type ChangeBody = { kind: 'change'; ops: SheetOp[]; acceptLosses: boolean }
/**
 * Undo (and redo, an undo of an undo): the parts the change `of` touched,
 * back as they were. Only while nobody else changed the file after it — the
 * server refuses it otherwise, and a concurrent change drops it.
 */
export type RevertBody = { kind: 'revert'; of: string; images: WireImages }
export type LogBody = ChangeBody | RevertBody

export type Author = { kind: 'user' | 'agent'; id: string; name: string }

export type LogEntry = {
  seq: number
  /** The grid tab or tool call that made it. */
  clientId: string
  /** The client's id for the change (resending it is harmless). */
  opId: string
  author: Author
  body: LogBody
  at: string
}

export type Submitted = { opId: string; body: LogBody }
export type SubmitRequest = { clientId: string; baseSeq: number; changes: Submitted[] }
export type SubmitResponse =
  | {
      state: 'ok'
      accepted: Array<{ opId: string; seq: number }>
      /** Not logged: why (it no longer applies after the others' changes). */
      rejected: Array<{ opId: string; error: string }>
      head: number
    }
  /** The client's copy is from before the file was replaced outside the session: load it again. */
  | { state: 'reload'; reason: string }

export type Peer = {
  clientId: string
  userId: string
  name: string
  /** A colour of the peer palette (index), stable per person. */
  color: number
  sheet: string | null
  /** "B3" or "B3:D9". */
  range: string | null
  /** Can change the file (view-only people watch). */
  editing: boolean
}

export type PresenceUpdate = { clientId: string; sheet: string | null; range: string | null }

/** Joining: the saved file to start from, and the entries after it. */
export type JoinView = {
  /** The SHA-256 of the file content the entries apply to (what GET …/content gives now). */
  baseSha256: string
  baseSeq: number
  head: number
  entries: LogEntry[]
  canEdit: boolean
  peers: Peer[]
}

/** What the live stream (SSE) sends. */
export type StreamEvent =
  | { event: 'entry'; data: LogEntry }
  | { event: 'peers'; data: Peer[] }
  /** The session wrote its revision: everything up to `seq` is in the file. */
  | { event: 'saved'; data: { seq: number; at: string } }
  /** The file was replaced outside the session (a restored revision, an upload): everyone loads it again. */
  | { event: 'reset'; data: { reason: string } }
  | { event: 'save_failed'; data: { error: string } }

export const MAX_BATCH = 200

/** `a` rewritten to apply after `b` (both made on the same state): none, or one. */
export function transformBody(a: LogBody, b: LogBody): LogBody[] {
  // An undo only stands while nobody else changed the file after what it undoes.
  if (a.kind === 'revert') return []
  if (b.kind === 'revert') return [a]
  const [ops] = transformLists(a.ops, b.ops, transform)
  return ops.length > 0 ? [{ ...a, ops }] : []
}

/** `items` (each with its body) rewritten past `others`, in order; items with nothing left go. */
export function rebaseItems<T extends { body: LogBody }>(items: T[], others: LogBody[]): T[] {
  const [out] = transformLists<{ item: T; body: LogBody }>(
    items.map((item) => ({ item, body: item.body })),
    others.map((body) => ({ item: null as unknown as T, body })),
    (a, b) => transformBody(a.body, b.body).map((body) => ({ item: a.item, body })),
  )
  return out.map(({ item, body }) => ({ ...item, body }))
}

/** JSON with sorted keys: bodies compared after a round trip through the database. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  )
}

/** The peer palette (cursor and name tag colours), light and dark readable. */
export const PEER_COLORS = ['#2563eb', '#db2777', '#16a34a', '#ea580c', '#7c3aed', '#0891b2', '#ca8a04', '#dc2626']

/** A stable colour per person (their id's hash). */
export function peerColor(userId: string): number {
  let h = 0
  for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) | 0
  return Math.abs(h) % PEER_COLORS.length
}
