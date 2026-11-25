import type { SessionRow, SheetLiveStore, SheetLiveTx } from './store'
import { createHash } from 'node:crypto'
import { createCalc } from '$lib/office/xlsx/calc'
import {
  peerColor,
  carriesSecret,
  rebaseItems,
  unpinned,
  type Author,
  type ChangeBody,
  type JoinView,
  type LogBody,
  type LogEntry,
  type Peer,
  type PresenceUpdate,
  type StreamEvent,
  type SubmitRequest,
  type SubmitResponse,
} from '$lib/office/xlsx/collab/protocol'
import { applyBody, seedOf, toWire } from '$lib/office/xlsx/collab/replica'
import { prepareSave } from '$lib/office/xlsx/ops'
import { openWorkbook, type Workbook } from '$lib/office/xlsx/workbook'
import type { Actor, DriveService, ItemView } from '$lib/server/drive'
import { DriveError } from '$lib/server/drive'

/**
 * Co-editing a workbook (plan/phase-office-files.md §7.9): the server side.
 *
 * - **Op log.** One session per open .xlsx file (`store`): numbered entries
 *   in the order accepted. `submit` takes a client's batch with the last
 *   entry it had, rewrites it past the entries since (the same transform
 *   every client runs), applies it to the server's own copy of the
 *   workbook — what does not apply is refused, never logged — and logs it.
 *   Resending a batch is harmless (change ids are unique per client).
 * - **One writer.** Only this service writes the file while a session is
 *   open: `flush` applies the log to the saved file and saves one revision
 *   (the Drive's binary write under the session's own edit-lock session,
 *   so a save in between by anything else is refused, and the revision is
 *   updated in place while the session keeps the lock), after a quiet spell,
 *   when the last person leaves, and for a tool's change when nobody is in.
 * - **Presence.** Who is in the file (each open tab), their sheet and
 *   selection; kept per process and shared through `publish` (Postgres
 *   NOTIFY in production), refreshed every `PRESENCE_BEAT_MS`, dropped after
 *   `PRESENCE_TTL_MS` of silence.
 * - **Streams.** Each open tab subscribes; entries, peers, saves and resets
 *   are pushed (the route turns them into SSE).
 */

export const SAVE_IDLE_MS = 4_000
export const SWEEP_MS = 30_000
export const PRESENCE_BEAT_MS = 15_000
export const PRESENCE_TTL_MS = 45_000
/** Entries stay this long after they are in the file (a tab back from a short offline spell catches up). */
export const KEEP_SAVED_MS = 24 * 60 * 60 * 1000
export const MAX_TAIL = 5_000

/** The edit-lock session (W-6) the live session writes under: one per file. */
export const liveLockSession = (fileId: string) => `sheet-live:${fileId}`

/** What one process tells the others (and itself) about a file. */
export type LiveMessage =
  | { k: 'entries'; f: string; seq: number }
  | { k: 'peer'; f: string; peer: Peer }
  | { k: 'gone'; f: string; clientId: string }
  | { k: 'saved'; f: string; seq: number; at: string }
  | { k: 'reset'; f: string; reason: string }
  | { k: 'save_failed'; f: string; error: string }

export type LiveTimers = {
  after(fn: () => void, ms: number): unknown
  every(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export type SheetLiveDeps = {
  drive: Pick<DriveService, 'readFile' | 'fileInfo' | 'writeBytes' | 'heartbeatLock' | 'releaseLock'>
  store: SheetLiveStore
  /** Delivers `m` to every process's `receive` (this one's too). */
  publish: (m: LiveMessage) => Promise<void>
  nameOf: (actor: Actor) => Promise<string>
  now?: () => Date
  idleMs?: number
  timers?: LiveTimers
}

export type Subscriber = { send: (e: StreamEvent) => void }

type Replica = { wb: Workbook; sha: string; seq: number }
export type { Actor }

type PeerAt = Peer & { at: number; local: boolean; actor: Actor | null }

const authorOf = (actor: Actor, name: string): Author =>
  actor.kind === 'user' ? { kind: 'user', id: actor.userId, name } : { kind: 'agent', id: actor.id, name }
const actorOf = (a: Author): Actor => (a.kind === 'user' ? { kind: 'user', userId: a.id } : { kind: 'agent', id: a.id })
const userIdOf = (actor: Actor) => (actor.kind === 'user' ? actor.userId : actor.id)
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export type SheetLive = ReturnType<typeof createSheetLive>

export function createSheetLive(deps: SheetLiveDeps) {
  const now = deps.now ?? (() => new Date())
  const idleMs = deps.idleMs ?? SAVE_IDLE_MS
  const timers: LiveTimers = deps.timers ?? {
    after: (fn, ms) => setTimeout(fn, ms),
    every: (fn, ms) => setInterval(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
  const replicas = new Map<string, Replica>()
  const peers = new Map<string, Map<string, PeerAt>>()
  const subscribers = new Map<string, Set<Subscriber & { last: number; chain: Promise<void> }>>()
  const idle = new Map<string, unknown>()
  let beat: unknown = null

  // -------------------------------------------------------------------------
  // The server's copy of each open workbook

  async function requireXlsx(actor: Actor, fileId: string) {
    const info = await deps.drive.fileInfo(actor, fileId)
    if (!/\.xls[xm]$/i.test(info.file.name) && info.file.mime !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      throw new DriveError('invalid', `“${info.file.name}” is not an Excel workbook (.xlsx); only workbooks are co-edited.`)
    return info
  }

  /** The workbook at the session's head (built from the saved file, then kept up to date). */
  async function replicaAt(tx: SheetLiveTx, s: SessionRow, actor: Actor, saved?: { bytes: Uint8Array; sha: string }): Promise<Replica> {
    let r = replicas.get(s.fileId)
    if (!r || r.seq < s.baseSeq || r.seq > s.headSeq || (r.seq === s.baseSeq && r.sha !== s.baseSha256)) {
      const file = saved ?? (await readSaved(actor, s.fileId))
      if (file.sha !== s.baseSha256) throw new ReplacedError()
      r = { wb: openWorkbook(file.bytes), sha: file.sha, seq: s.baseSeq }
      replicas.set(s.fileId, r)
    }
    for (const e of await tx.entriesAfter(r.seq)) {
      applyBody(r.wb, e.body, seedOf(e.clientId, e.opId))
      r.seq = e.seq
    }
    return r
  }

  async function readSaved(actor: Actor, fileId: string) {
    const { file, bytes } = await deps.drive.readFile(actor, fileId)
    return { bytes, sha: file.sha256 }
  }

  class ReplacedError extends Error {
    constructor() {
      super('The file was replaced outside the co-editing session.')
    }
  }

  /** The file was replaced while entries were not in it yet: they are left behind, everyone reloads. */
  async function reset(tx: SheetLiveTx, s: SessionRow, sha: string): Promise<SessionRow> {
    const next = { ...s, baseSha256: sha, baseSeq: s.headSeq, epochSeq: s.headSeq, updatedAt: now() }
    await tx.putSession(next)
    replicas.delete(s.fileId)
    return next
  }

  const RESET_REASON = 'The file was replaced (a restored version or an upload) while it was open; its newest version is shown.'

  // -------------------------------------------------------------------------
  // Joining, changes, the log

  async function join(actor: Actor, fileId: string): Promise<JoinView> {
    const info = await requireXlsx(actor, fileId)
    let wasReset = false
    const out = await deps.store.locked(fileId, async (tx) => {
      const saved = await readSaved(actor, fileId)
      let s = await tx.session()
      if (!s) {
        s = { fileId, baseSha256: saved.sha, baseSeq: 0, headSeq: 0, epochSeq: 0, updatedAt: now(), savedAt: null }
        await tx.putSession(s)
      } else if (s.baseSha256 !== saved.sha) {
        if (s.headSeq === s.baseSeq) {
          s = { ...s, baseSha256: saved.sha, epochSeq: s.headSeq }
          await tx.putSession(s)
          replicas.delete(fileId)
        } else {
          s = await reset(tx, s, saved.sha)
          wasReset = true
        }
      }
      const entries = await tx.entriesAfter(s.baseSeq, MAX_TAIL + 1)
      if (entries.length > MAX_TAIL) throw new DriveError('invalid', 'This workbook has too many unsaved changes to open right now; try again in a moment.')
      return { s, entries }
    })
    if (wasReset) await deps.publish({ k: 'reset', f: fileId, reason: RESET_REASON })
    return {
      baseSha256: out.s.baseSha256,
      baseSeq: out.s.baseSeq,
      head: out.s.headSeq,
      entries: out.entries,
      canEdit: info.canEdit,
      peers: await activePeers(fileId),
    }
  }

  async function entriesAfter(actor: Actor, fileId: string, seq: number): Promise<LogEntry[]> {
    await requireXlsx(actor, fileId)
    const s = await deps.store.session(fileId)
    if (s && seq < s.epochSeq) throw new DriveError('conflict', RESET_REASON)
    return deps.store.entriesAfter(fileId, seq, MAX_TAIL)
  }

  async function submit(actor: Actor, fileId: string, req: SubmitRequest): Promise<SubmitResponse> {
    const info = await requireXlsx(actor, fileId)
    if (!info.canEdit) throw new DriveError('forbidden', `You can only view “${info.file.name}”.`)
    const author = authorOf(actor, await deps.nameOf(actor))
    let res: SubmitResponse
    try {
      res = await deps.store.locked(fileId, async (tx) => {
        const s = await tx.session()
        if (!s || req.baseSeq < s.epochSeq || req.baseSeq > s.headSeq)
          return { state: 'reload', reason: RESET_REASON } as const
        // A batch is logged whole or not at all: its first change says which.
        const first = req.changes[0]
        if (first) {
          const had = await tx.findEntry(req.clientId, first.opId)
          if (had) {
            const accepted = []
            for (const c of req.changes) {
              const e = await tx.findEntry(req.clientId, c.opId)
              if (e) accepted.push({ opId: c.opId, seq: e.seq })
            }
            return { state: 'ok', accepted, rejected: [], head: s.headSeq } as const
          }
        }
        const since = await tx.entriesAfter(req.baseSeq)
        const { kept: items, refused } = rebaseItems(req.changes, since.map((e) => e.body))
        const kept = new Set(items.map((i) => i.opId))
        const why = new Map(refused.map((x) => [x.item.opId, x.reason]))
        const rejected: Array<{ opId: string; error: string }> = req.changes
          .filter((c) => !kept.has(c.opId))
          .map((c) => ({
            opId: c.opId,
            error: why.get(c.opId) ?? 'It no longer applies: what it changed was removed by someone else meanwhile.',
          }))
        const r = await replicaAt(tx, s, actor)
        const entries: LogEntry[] = []
        let head = s.headSeq
        const at = now().toISOString()
        for (const it of items) {
          if (it.body.kind === 'parts') {
            rejected.push({ opId: it.opId, error: 'Only the server logs a change as its result.' })
            continue
          }
          const notPinned = it.body.kind === 'change' ? unpinned(it.body) : null
          if (notPinned) {
            rejected.push({ opId: it.opId, error: notPinned })
            continue
          }
          if (it.body.kind === 'revert') {
            const why = await revertRefusal(tx, req.clientId, it.body.of, entries)
            if (why) {
              rejected.push({ opId: it.opId, error: why })
              continue
            }
          }
          let body: LogBody = it.body
          let step: ReturnType<typeof applyBody>['step'] | null = null
          try {
            step = applyBody(r.wb, it.body, seedOf(req.clientId, it.opId)).step
            // A password never travels on or stays in the log: the change is logged as its result.
            if (it.body.kind === 'change' && carriesSecret(it.body))
              body = { kind: 'parts', of: it.opId, images: toWire(step.after) }
          } catch (err) {
            // Applied but not loggable (its result too large to share): taken back from the server's copy too.
            if (step) r.wb.restore(step.before)
            rejected.push({ opId: it.opId, error: errorText(err) })
            continue
          }
          head++
          r.seq = head
          entries.push({ seq: head, clientId: req.clientId, opId: it.opId, author, body, at })
        }
        if (entries.length > 0) {
          await tx.append(entries)
          await tx.putSession({ ...s, headSeq: head, updatedAt: now() })
        }
        return {
          state: 'ok',
          accepted: entries.map((e) => ({ opId: e.opId, seq: e.seq })),
          rejected,
          head,
        } as const
      })
    } catch (err) {
      // The server's copy may be ahead of what was logged: build it again next time.
      replicas.delete(fileId)
      if (err instanceof ReplacedError) return { state: 'reload', reason: RESET_REASON }
      throw err
    }
    if (res.state === 'ok' && res.accepted.length > 0) {
      await deps.publish({ k: 'entries', f: fileId, seq: res.head })
      scheduleSave(fileId)
    }
    return res
  }

  /** Why an undo can't stand (someone else changed the file after what it undoes), or null. */
  async function revertRefusal(tx: SheetLiveTx, clientId: string, of: string, batch: LogEntry[]): Promise<string | null> {
    const target = batch.find((e) => e.opId === of) ?? (await tx.findEntry(clientId, of))
    if (!target || target.clientId !== clientId) return 'There is nothing of yours to undo there.'
    const after = [...(await tx.entriesAfter(target.seq)), ...batch.filter((e) => e.seq > target.seq)]
    if (after.some((e) => e.clientId !== clientId))
      return 'Someone else changed the file since; undo is no longer possible.'
    return null
  }

  // -------------------------------------------------------------------------
  // Saving: one writer

  function scheduleSave(fileId: string) {
    const h = idle.get(fileId)
    if (h !== undefined) timers.clear(h)
    idle.set(
      fileId,
      timers.after(() => {
        idle.delete(fileId)
        void save(fileId).catch((err) => console.error('[sheet-live] saving after a pause failed', { fileId, err }))
      }, idleMs),
    )
  }

  /**
   * Writes the log into the file as one revision. Returns what was saved
   * (null: nothing to save, or it could not be saved now — the stream says
   * why and the next pause tries again).
   */
  async function save(fileId: string): Promise<{ file: ItemView; revision: { id: string; createdAt: Date } } | null> {
    let message: LiveMessage | null = null
    const out = await deps.store.locked(fileId, async (tx) => {
      const s = await tx.session()
      if (!s || s.headSeq === s.baseSeq) return null
      const [last] = await tx.entriesAfter(s.headSeq - 1, 1)
      if (!last) throw new Error(`sheet-live: entry ${s.headSeq} of ${fileId} is missing`)
      const actor = actorOf(last.author)
      let saved: { bytes: Uint8Array; sha: string }
      try {
        saved = await readSaved(actor, fileId)
      } catch (err) {
        message = { k: 'save_failed', f: fileId, error: errorText(err) }
        return null
      }
      if (saved.sha !== s.baseSha256) {
        await reset(tx, s, saved.sha)
        message = { k: 'reset', f: fileId, reason: RESET_REASON }
        return null
      }
      const r = await replicaAt(tx, s, actor, saved)
      prepareSave(r.wb, createCalc(r.wb))
      const bytes = r.wb.pkg.toBytes()
      try {
        const written = await deps.drive.writeBytes(actor, fileId, bytes, liveLockSession(fileId), { baseSha256: s.baseSha256 })
        r.sha = sha256(bytes)
        const at = now()
        await tx.putSession({ ...s, baseSha256: r.sha, baseSeq: s.headSeq, savedAt: at })
        await tx.prune(s.headSeq, new Date(at.getTime() - KEEP_SAVED_MS))
        message = { k: 'saved', f: fileId, seq: s.headSeq, at: at.toISOString() }
        return { saved: { file: written.file, revision: { id: written.revision.id, createdAt: written.revision.createdAt } }, actor }
      } catch (err) {
        replicas.delete(fileId)
        if (err instanceof DriveError && err.code === 'conflict') {
          await reset(tx, s, (await readSaved(actor, fileId)).sha)
          message = { k: 'reset', f: fileId, reason: RESET_REASON }
          return null
        }
        if (err instanceof DriveError) {
          message = { k: 'save_failed', f: fileId, error: err.message }
          return null
        }
        throw err
      }
    })
    if (message) await deps.publish(message)
    if (out && (await activePeers(fileId)).length === 0) {
      await deps.drive.releaseLock(out.actor, fileId, liveLockSession(fileId)).catch(() => {})
    }
    return out ? out.saved : null
  }

  /** Saves what a pause left unsaved anywhere (a process that went away, a tool's change). */
  async function sweep() {
    await deps.store.prunePeers(new Date(now().getTime() - PRESENCE_TTL_MS))
    for (const fileId of await deps.store.unsaved(new Date(now().getTime() - idleMs))) {
      await save(fileId).catch((err) => console.error('[sheet-live] sweep save failed', { fileId, err }))
    }
  }

  // -------------------------------------------------------------------------
  // Presence and streams

  function peersOf(fileId: string): Peer[] {
    const cutoff = now().getTime() - PRESENCE_TTL_MS
    return [...(peers.get(fileId)?.values() ?? [])]
      .filter((p) => p.local || p.at >= cutoff)
      .map(({ at: _at, local: _local, actor: _actor, ...p }) => p)
  }

  async function activePeers(fileId: string): Promise<Peer[]> {
    const cutoff = new Date(now().getTime() - PRESENCE_TTL_MS)
    const live = await deps.store.livePeers(fileId, cutoff)
    const map = peers.get(fileId) ?? new Map<string, PeerAt>()
    const keep = new Set(live.map((p) => p.clientId))
    for (const [id, entry] of map) {
      if (!entry.local && !keep.has(id)) map.delete(id)
    }
    for (const p of live) {
      const mine = map.get(p.clientId)
      map.set(p.clientId, { ...p, at: now().getTime(), local: mine?.local ?? false, actor: mine?.actor ?? null })
    }
    if (map.size > 0) peers.set(fileId, map)
    else peers.delete(fileId)
    return peersOf(fileId)
  }

  function tell(fileId: string, e: StreamEvent) {
    for (const sub of subscribers.get(fileId) ?? []) {
      try {
        sub.send(e)
      } catch (err) {
        console.error('[sheet-live] a stream send failed', { fileId, err })
      }
    }
  }

  function sendEntries(fileId: string) {
    for (const sub of subscribers.get(fileId) ?? []) {
      sub.chain = sub.chain
        .then(async () => {
          const s = await deps.store.session(fileId)
          if (s && sub.last < s.epochSeq) {
            sub.send({ event: 'reset', data: { reason: RESET_REASON } })
            sub.last = s.epochSeq
          }
          const entries = await deps.store.entriesAfter(fileId, sub.last, MAX_TAIL)
          for (const e of entries) {
            sub.last = e.seq
            sub.send({ event: 'entry', data: e })
          }
        })
        .catch((err) => console.error('[sheet-live] sending entries failed', { fileId, err }))
    }
  }

  function hasLocalPeers(fileId: string): boolean {
    for (const p of peers.get(fileId)?.values() ?? []) if (p.local) return true
    return false
  }

  /** A message from any process (this one's own included). */
  function receive(m: LiveMessage) {
    switch (m.k) {
      case 'entries':
        sendEntries(m.f)
        if (hasLocalPeers(m.f)) scheduleSave(m.f)
        return
      case 'peer': {
        const map = peers.get(m.f) ?? new Map<string, PeerAt>()
        const mine = map.get(m.peer.clientId)
        map.set(m.peer.clientId, { ...m.peer, at: now().getTime(), local: mine?.local ?? false, actor: mine?.actor ?? null })
        peers.set(m.f, map)
        return tell(m.f, { event: 'peers', data: peersOf(m.f) })
      }
      case 'gone': {
        const map = peers.get(m.f)
        if (map?.get(m.clientId)?.local === false) map.delete(m.clientId)
        return tell(m.f, { event: 'peers', data: peersOf(m.f) })
      }
      case 'saved':
        return tell(m.f, { event: 'saved', data: { seq: m.seq, at: m.at } })
      case 'reset':
        replicas.delete(m.f)
        return tell(m.f, { event: 'reset', data: { reason: m.reason } })
      case 'save_failed':
        return tell(m.f, { event: 'save_failed', data: { error: m.error } })
    }
  }

  /** Re-syncs active local streams after Postgres LISTEN reconnects. */
  async function resync() {
    for (const fileId of [...subscribers.keys()]) {
      const live = await activePeers(fileId)
      tell(fileId, { event: 'peers', data: live })
      sendEntries(fileId)
      const s = await deps.store.session(fileId)
      if (s && s.headSeq > s.baseSeq && hasLocalPeers(fileId)) scheduleSave(fileId)
    }
  }

  /**
   * One open tab of the file: its stream (from entry `after`) and its place
   * among the peers. View access is enough (view-only people watch). The
   * returned function ends it; the last person leaving saves the file.
   */
  async function connect(actor: Actor, fileId: string, clientId: string, after: number, send: Subscriber['send']): Promise<() => Promise<void>> {
    const info = await requireXlsx(actor, fileId)
    const s = await deps.store.session(fileId)
    if (s && after < s.epochSeq) {
      send({ event: 'reset', data: { reason: RESET_REASON } })
    }
    await activePeers(fileId)
    const sub = { send, last: Math.max(after, s?.epochSeq ?? 0), chain: Promise.resolve() }
    const set = subscribers.get(fileId) ?? new Set()
    set.add(sub)
    subscribers.set(fileId, set)
    const peer: Peer = {
      clientId,
      userId: userIdOf(actor),
      name: await deps.nameOf(actor),
      color: peerColor(userIdOf(actor)),
      sheet: null,
      range: null,
      editing: info.canEdit,
    }
    await deps.store.putPeer(fileId, peer, now())
    const map = peers.get(fileId) ?? new Map<string, PeerAt>()
    map.set(clientId, { ...peer, at: now().getTime(), local: true, actor })
    peers.set(fileId, map)
    startBeat()
    send({ event: 'peers', data: peersOf(fileId) })
    sendEntries(fileId)
    await deps.publish({ k: 'peer', f: fileId, peer })
    let done = false
    return async () => {
      if (done) return
      done = true
      set.delete(sub)
      if (set.size === 0) subscribers.delete(fileId)
      const p = peers.get(fileId)
      p?.delete(clientId)
      await deps.store.removePeer(fileId, clientId)
      await deps.publish({ k: 'gone', f: fileId, clientId })
      if ((await activePeers(fileId)).length === 0) await close(fileId, actor)
    }
  }

  /** Nobody is in the file any more: what is left is saved and the edit lock goes. */
  async function close(fileId: string, actor: Actor) {
    const h = idle.get(fileId)
    if (h !== undefined) timers.clear(h)
    idle.delete(fileId)
    await save(fileId)
    const s = await deps.store.session(fileId)
    if (s && s.headSeq === s.baseSeq) await deps.drive.releaseLock(actor, fileId, liveLockSession(fileId))
    replicas.delete(fileId)
    peers.delete(fileId)
  }

  async function presence(actor: Actor, fileId: string, update: PresenceUpdate) {
    await requireXlsx(actor, fileId)
    const local = peers.get(fileId)?.get(update.clientId)
    const found = local ?? (await deps.store.findPeer(fileId, update.clientId))
    if (!found || found.userId !== userIdOf(actor)) throw new DriveError('not_found', 'That tab is not connected to this file.')
    const peer: Peer = {
      clientId: found.clientId,
      userId: found.userId,
      name: found.name,
      color: found.color,
      editing: found.editing,
      sheet: update.sheet,
      range: update.range,
    }
    if (local) peers.get(fileId)?.set(update.clientId, { ...local, sheet: update.sheet, range: update.range, at: now().getTime() })
    await deps.store.putPeer(fileId, peer, now())
    await deps.publish({ k: 'peer', f: fileId, peer })
  }

  /** Every PRESENCE_BEAT_MS: this process's tabs say they are still here, its editors keep the edit lock, and pauses are saved. */
  function startBeat() {
    if (beat !== null) return
    let ticks = 0
    beat = timers.every(() => {
      ticks++
      void (async () => {
        for (const [fileId, map] of peers) {
          for (const p of map.values()) {
            if (!p.local) continue
            const { at: _at, local: _local, actor: _actor, ...peer } = p
            await deps.store.putPeer(fileId, peer, now())
            await deps.publish({ k: 'peer', f: fileId, peer })
          }
          const editor = [...map.values()].find((p) => p.local && p.editing && p.actor)
          if (editor?.actor) await deps.drive.heartbeatLock(editor.actor, fileId, liveLockSession(fileId)).catch(() => {})
          if (peersOf(fileId).length === 0) peers.delete(fileId)
        }
        if (ticks % Math.max(1, Math.round(SWEEP_MS / PRESENCE_BEAT_MS)) === 0) await sweep()
      })().catch((err) => console.error('[sheet-live] presence beat failed', err))
    }, PRESENCE_BEAT_MS)
    ;(beat as { unref?: () => void } | undefined)?.unref?.()
  }

  function stop() {
    if (beat !== null) {
      timers.clear(beat)
      beat = null
    }
    for (const h of idle.values()) timers.clear(h)
    idle.clear()
  }

  // -------------------------------------------------------------------------
  // The agent's sheet tools

  /**
   * The workbook as the session has it, for a tool's read or change: null
   * when no session is open (nobody in the file, nothing unsaved) — then the
   * saved file is current and the tool works on it directly.
   */
  async function book(actor: Actor, fileId: string): Promise<{ file: ItemView; bytes: Uint8Array; seq: number; baseSha256: string } | null> {
    const info = await requireXlsx(actor, fileId)
    const s = await deps.store.session(fileId)
    const open = (await activePeers(fileId)).length > 0 || (s !== null && s.headSeq > s.baseSeq)
    if (!s || !open) return null
    return deps.store.locked(fileId, async (tx) => {
      const cur = await tx.session()
      if (!cur) return null
      const r = await replicaAt(tx, cur, actor)
      return { file: info.file, bytes: r.wb.pkg.toBytes(), seq: r.seq, baseSha256: cur.baseSha256 }
    })
  }

  /**
   * A tool's changes into the session's log (made on `book`'s workbook at
   * `seq`). Saved at once when nobody is in the file; otherwise with the
   * session's next save, and the open grids show them now.
   */
  async function commit(actor: Actor, fileId: string, seq: number, changes: ChangeBody[], clientId: string) {
    const res = await submit(actor, fileId, {
      clientId,
      baseSeq: seq,
      changes: changes.map((body, i) => ({ opId: `${clientId}:${i}`, body })),
    })
    if (res.state === 'reload') throw new DriveError('conflict', res.reason)
    if (res.rejected.length > 0)
      throw new DriveError('conflict', `Someone changed the workbook at the same time, so this change was not made: ${res.rejected[0]!.error}`)
    const people = (await activePeers(fileId)).length
    const saved = people === 0 ? await save(fileId) : null
    return { seq: res.head, people, saved }
  }

  return { join, entriesAfter, submit, save, sweep, receive, resync, connect, presence, peers: peersOf, book, commit, stop }
}
