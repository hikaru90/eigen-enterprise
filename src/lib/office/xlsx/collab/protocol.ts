import type { SheetOp } from '../ops'
import { transform, transformLists, TransformRefusal } from './transform'

/**
 * Co-editing a workbook (plan/phase-office-files.md §7.9): what travels
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
/**
 * A change the server logs as its result (the parts as they are after it)
 * rather than as itself: one that carries a password (protecting a sheet or
 * the workbook), which must not travel to everyone in the file or stay in
 * the log. Only the server makes these.
 */
export type PartsBody = { kind: 'parts'; of: string; images: WireImages }
export type LogBody = ChangeBody | RevertBody | PartsBody

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

/**
 * A pending `a` rewritten to apply after `b` (both made on the same state):
 * none (nothing left for it to act on) or one. Throws TransformRefusal when
 * it can't be made to fit — an undo always, once someone else changed the
 * file after what it undoes.
 */
export function transformBody(a: LogBody, b: LogBody): LogBody[] {
  if (a.kind !== 'change') throw new TransformRefusal(UNDO_GONE)
  if (b.kind !== 'change') return [a]
  const [ops] = transformLists(a.ops, b.ops, transform)
  return ops.length > 0 ? [{ ...a, ops }] : []
}

export const UNDO_GONE = 'Someone else changed the file since; undo is no longer possible.'
const AFTER_REFUSED = 'It came after one of your changes that could not be made, so it was not made either.'

/** The logged `b` rewritten to apply after the pending `a` (to fit the changes that follow `a`). */
function remotePast(b: LogBody, a: LogBody): LogBody {
  if (b.kind !== 'change' || a.kind !== 'change') return b
  const [, ops] = transformLists(a.ops, b.ops, transform)
  return { ...b, ops }
}

export type Rebased<T> = { kept: T[]; refused: Array<{ item: T; reason: string }> }

/**
 * Pending `items` (each with its body, in order) rewritten past the logged
 * `others`, in order — what the server does with a batch and what a client
 * does with its unsent changes, so both get the same result. An item with
 * nothing left goes (not in `kept`, not refused); an item that can't be made
 * to fit is refused with the reason, and every item after it too (they were
 * made on top of it).
 */
export function rebaseItems<T extends { body: LogBody }>(items: T[], others: LogBody[]): Rebased<T> {
  let cur = items.map((item) => ({ item, body: item.body }))
  const refused: Array<{ item: T; reason: string }> = []
  let blocked: string | null = null
  for (const other of others) {
    let b: LogBody = other
    const next: typeof cur = []
    for (const it of cur) {
      if (blocked !== null) {
        refused.push({ item: it.item, reason: blocked })
        continue
      }
      let past: LogBody[]
      try {
        past = transformBody(it.body, b)
        b = remotePast(b, it.body)
      } catch (err) {
        if (!(err instanceof TransformRefusal)) throw err
        refused.push({ item: it.item, reason: err.message })
        blocked = AFTER_REFUSED
        continue
      }
      if (past.length > 0) next.push({ item: it.item, body: past[0]! })
    }
    cur = next
  }
  return { kept: cur.map(({ item, body }) => ({ ...item, body })), refused }
}

// ---------------------------------------------------------------------------
// Bytes on the wire (a picture's image): JSON carries them as { $bytes: base64 }

const CHUNK = 0x8000

export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(out)
}

export function fromBase64(text: string): Uint8Array {
  const str = atob(text)
  const out = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i)
  return out
}

/** A plain JSON copy of `value` with bytes as { $bytes } (also drops the reactive proxies a page hands over). */
export function toWireValue<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_k, v: unknown) => (v instanceof Uint8Array ? { $bytes: toBase64(v) } : v)),
  ) as T
}

/** `value` with every { $bytes } back as bytes (a copy). */
export function fromWireValue<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
      const o = v as Record<string, unknown>
      const keys = Object.keys(o)
      if (keys.length === 1 && keys[0] === '$bytes' && typeof o.$bytes === 'string') return fromBase64(o.$bytes)
      return Object.fromEntries(keys.map((k) => [k, walk(o[k])]))
    }
    return v
  }
  return walk(value) as T
}

// ---------------------------------------------------------------------------
// What is fixed before a change travels

/** Operations whose apply reads the clock unless told the time: their time is set where they are made. */
const TIMED = new Set<string>(['add_comment', 'reply_comment'])

function eachOp(ops: SheetOp[], fn: (op: SheetOp) => void) {
  for (const op of ops) {
    if (op.op === 'batch') eachOp(op.ops, fn)
    else fn(op)
  }
}

/** The change as it travels: a plain copy, bytes encoded, comment times set (every replica writes the same). */
export function pinChange(body: ChangeBody, now: () => Date = () => new Date()): ChangeBody {
  const out = toWireValue(body)
  eachOp(out.ops, (op) => {
    const timed = op as { now?: string }
    if (TIMED.has(op.op) && !timed.now) timed.now = now().toISOString()
  })
  return out
}

/** Why a change can't be logged as sent (a comment without its time), or null. */
export function unpinned(body: ChangeBody): string | null {
  let why: string | null = null
  eachOp(body.ops, (op) => {
    if (TIMED.has(op.op) && !(op as { now?: string }).now) why = `${op.op} needs its time (now) set where it is made.`
  })
  return why
}

/** Whether the change carries a password (then it is logged as its result: `PartsBody`). */
export function carriesSecret(body: ChangeBody): boolean {
  let found = false
  eachOp(body.ops, (op) => {
    const pw = (op as { password?: string | null }).password
    if (typeof pw === 'string' && pw.length > 0) found = true
  })
  return found
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
