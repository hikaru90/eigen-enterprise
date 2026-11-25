import type { SheetEditor } from '../editor'
import { createCalc, type Calc } from '../calc'
import { lossesOf, prepareSave, type OpResult, type SheetOp } from '../ops'
import { openWorkbook, XlsxError } from '../workbook'
import {
  canonical,
  MAX_BATCH,
  pinChange,
  rebaseItems,
  toWireValue,
  type LogBody,
  type LogEntry,
  type SubmitRequest,
  type SubmitResponse,
} from './protocol'
import { applyBody, seedOf, toWire, type Step } from './replica'

/**
 * One grid's side of co-editing a workbook (plan/phase-office-files.md §7.9).
 *
 * The workbook on screen is the server's log applied in order (`confirmed`,
 * up to `seq`) plus this tab's own changes the server has not logged yet
 * (`pending`), applied on top. A change shows at once and is sent; one batch
 * is in flight at a time, and the next goes only after the server's entries
 * for the last one came back, so every batch is based on a state that
 * already has this tab's earlier changes. When someone else's entry comes
 * in, the pending changes are taken off, the entry is applied, and the
 * pending ones are rewritten past it (./transform.ts) and put back — the
 * same rewriting the server does, so this tab's changes come back from the
 * server exactly as they now stand here.
 *
 * Undo and redo are entries too (the parts the change touched, put back).
 * They stand only while nobody else changed the file: someone else's entry
 * clears this tab's undo and redo history.
 */

export type LiveTransport = {
  submit(req: SubmitRequest): Promise<SubmitResponse>
  /** Entries after `seq` (a gap in the stream). */
  entriesAfter(seq: number): Promise<LogEntry[]>
}

export type LiveEvents = {
  /** The workbook changed under this tab (someone else's entry, or own changes taken back): draw again. */
  onChanged?: (by: LogEntry | null) => void
  /**
   * One of this tab's changes could not stand after the others' and was
   * taken back: the reason, or null when nothing is left for it to act on
   * (its rows or sheet were deleted meanwhile).
   */
  onRejected?: (error: string | null) => void
  /** This copy can't continue: load the file and join again. */
  onReload?: (reason: string) => void
  /** Sending failed (offline): pending changes stay and go again with `resend`. */
  onOffline?: (error: unknown) => void
  /** How many changes are not in the server's log yet. */
  onPending?: (count: number) => void
}

export type LiveSheet = SheetEditor & {
  readonly clientId: string
  /** The last server entry applied. */
  seq(): number
  pending(): number
  receive(entries: LogEntry[]): void
  /** After a reconnect: the batch in flight goes again (the server ignores what it already has). */
  resend(): void
  /** Stops sending (the tab closes or loads the file again). */
  close(): void
}

type Pending = { opId: string; body: LogBody; step: Step }
type History = { opId: string; step: Step }

export function createLiveSheet(opts: {
  bytes: Uint8Array
  baseSeq: number
  entries: LogEntry[]
  clientId: string
  transport: LiveTransport
  newId: () => string
  events?: LiveEvents
}): LiveSheet {
  const wb = openWorkbook(opts.bytes)
  const ev = opts.events ?? {}
  let seq = opts.baseSeq
  for (const e of opts.entries) {
    if (e.seq !== seq + 1) throw new XlsxError(`The change log has a gap after entry ${seq}.`)
    applyBody(wb, e.body, seedOf(e.clientId, e.opId))
    seq = e.seq
  }
  let pending: Pending[] = []
  /** The batch the server has (or is getting), by change id. */
  let inflight: { req: SubmitRequest; ids: Set<string> } | null = null
  /** Don't send again before the server's entries up to here came back. */
  let awaitSeq = 0
  let undoStack: History[] = []
  let redoStack: History[] = []
  let version = 0
  let calc: Calc | null = null
  let dirty = false
  let closed = false
  let catchingUp = false

  const bump = () => {
    version++
    calc = null
    dirty = true
  }
  const tellPending = () => ev.onPending?.(pending.length)

  function rewind() {
    for (let i = pending.length - 1; i >= 0; i--) wb.restore(pending[i]!.step.before)
  }

  /**
   * Puts `items` back on top, in order. One that no longer applies (or that
   * the rewriting dropped, `before` lists what there was) is taken back and
   * said — by the server's answer when it is in flight, else here.
   */
  function reapply(
    items: Array<{ opId: string; body: LogBody }>,
    before: Pending[] = items as Pending[],
    refused: Array<{ item: Pending; reason: string }> = [],
  ) {
    const kept: Pending[] = []
    const left = new Set(items.map((i) => i.opId))
    const why = new Map(refused.map((r) => [r.item.opId, r.reason]))
    for (const p of before) {
      if (left.has(p.opId) || inflight?.ids.has(p.opId)) continue
      ev.onRejected?.(why.get(p.opId) ?? null)
    }
    for (const it of items) {
      try {
        kept.push({ ...it, step: applyBody(wb, it.body, seedOf(opts.clientId, it.opId)).step })
      } catch (err) {
        if (!inflight?.ids.has(it.opId)) ev.onRejected?.(err instanceof Error ? err.message : String(err))
      }
    }
    pending = kept
  }

  function confirm(entry: LogEntry) {
    try {
      applyBody(wb, entry.body, seedOf(entry.clientId, entry.opId))
    } catch (err) {
      // The server applied it to the same workbook: this copy is out of step.
      console.error('[xlsx live] a logged change did not apply here', { seq: entry.seq, err })
      fail(`This copy is out of step with the server (change ${entry.seq} did not apply).`)
      return false
    }
    seq = entry.seq
    return true
  }

  function fail(reason: string) {
    closed = true
    ev.onReload?.(reason)
  }

  function receiveOne(entry: LogEntry) {
    if (entry.seq <= seq) return
    const own = entry.clientId === opts.clientId
    const k = own ? pending.findIndex((p) => p.opId === entry.opId) : -1
    if (k === 0 && canonical(pending[0]!.body) === canonical(entry.body)) {
      // Ours, as it stands here: it is already on screen.
      pending.shift()
      seq = entry.seq
      if (inflight && !pending.some((p) => inflight!.ids.has(p.opId))) inflight = null
      return
    }
    rewind()
    if (k >= 0) {
      // Ours, but the server has it (or what was before it) differently: take the server's.
      const rest = pending.slice(k + 1)
      if (!confirm(entry)) return
      reapply(rest)
    } else {
      const rest = pending
      if (!confirm(entry)) return
      const { kept, refused } = rebaseItems(rest, [entry.body])
      reapply(kept, rest, refused)
      // Someone else changed the file: this tab's history no longer fits it.
      undoStack = []
      redoStack = []
    }
    if (inflight && !pending.some((p) => inflight!.ids.has(p.opId))) inflight = null
    bump()
    ev.onChanged?.(own ? null : entry)
  }

  function receive(entries: LogEntry[]) {
    if (closed) return
    const sorted = [...entries].sort((a, b) => a.seq - b.seq)
    for (const e of sorted) {
      if (closed) return
      if (e.seq <= seq) continue
      if (e.seq > seq + 1) {
        void catchUp()
        return
      }
      receiveOne(e)
    }
    tellPending()
    send()
  }

  async function catchUp() {
    if (catchingUp) return
    catchingUp = true
    try {
      const more = await opts.transport.entriesAfter(seq)
      catchingUp = false
      receive(more)
    } catch (err) {
      catchingUp = false
      ev.onOffline?.(err)
    }
  }

  function send() {
    if (closed || inflight || pending.length === 0 || seq < awaitSeq) return
    const batch = pending.slice(0, MAX_BATCH)
    const req: SubmitRequest = {
      clientId: opts.clientId,
      baseSeq: seq,
      changes: batch.map((p) => ({ opId: p.opId, body: p.body })),
    }
    inflight = { req, ids: new Set(batch.map((p) => p.opId)) }
    void submit(req)
  }

  async function submit(req: SubmitRequest) {
    let res: SubmitResponse
    try {
      res = await opts.transport.submit(req)
    } catch (err) {
      ev.onOffline?.(err)
      return
    }
    if (closed || inflight?.req !== req) return
    inflight = null
    if (res.state === 'reload') return fail(res.reason)
    awaitSeq = Math.max(awaitSeq, ...res.accepted.map((a) => a.seq))
    const refused = new Set(res.rejected.map((r) => r.opId))
    if (pending.some((p) => refused.has(p.opId))) {
      rewind()
      reapply(pending.filter((p) => !refused.has(p.opId)))
      bump()
      ev.onChanged?.(null)
    }
    for (const r of res.rejected) ev.onRejected?.(r.error)
    tellPending()
    send()
  }

  function local(made: LogBody): { result: OpResult; step: Step; opId: string } {
    if (closed) throw new XlsxError('This copy is no longer connected; reload the file.')
    // A plain copy: the page may hand over reactive proxies ($state), which can't be cloned or
    // transformed, and a change must not move when the page's object does.
    const body: LogBody = made.kind === 'change' ? pinChange(made) : toWireValue(made)
    const opId = opts.newId()
    const { result, step } = applyBody(wb, body, seedOf(opts.clientId, opId))
    pending.push({ opId, body, step })
    bump()
    tellPending()
    send()
    return { result, step, opId }
  }

  return {
    wb,
    clientId: opts.clientId,
    calc: () => (calc ??= createCalc(wb)),
    apply(op: SheetOp, o?: { acceptLosses?: boolean }) {
      const { result, step, opId } = local({ kind: 'change', ops: [op], acceptLosses: !!o?.acceptLosses })
      undoStack.push({ opId, step })
      redoStack = []
      return result
    },
    losses: (op) => lossesOf(wb, op),
    undo() {
      const top = undoStack.at(-1)
      if (!top) return null
      const { result, step, opId } = local({ kind: 'revert', of: top.opId, images: toWire(top.step.before) })
      undoStack.pop()
      redoStack.push({ opId, step })
      return result
    },
    redo() {
      const top = redoStack.at(-1)
      if (!top) return null
      const { result, step, opId } = local({ kind: 'revert', of: top.opId, images: toWire(top.step.before) })
      redoStack.pop()
      undoStack.push({ opId, step })
      return result
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    version: () => version,
    changed: () => dirty,
    toBytes() {
      const c = (calc ??= createCalc(wb))
      prepareSave(wb, c)
      calc = null
      return wb.pkg.toBytes()
    },
    seq: () => seq,
    pending: () => pending.length,
    receive,
    resend() {
      if (closed) return
      if (inflight) void submit(inflight.req)
      else if (seq < awaitSeq) void catchUp()
      else send()
    },
    close() {
      closed = true
    },
  }
}
