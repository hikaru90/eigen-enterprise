import type { DriveItem } from '$lib/drive/api'
import { createCalc } from '../calc'
import {
  canonical,
  peerColor,
  rebaseItems,
  type JoinView,
  type LogEntry,
  type Peer,
  type PresenceUpdate,
  type StreamEvent,
  type SubmitRequest,
  type SubmitResponse,
} from '../collab/protocol'
import { applyBody, seedOf } from '../collab/replica'
import { prepareSave } from '../ops'
import { openWorkbook } from '../workbook'

/**
 * Browser-safe in-memory co-editing server harness for `*.svelte.spec.ts`
 * component tests. Supports multiple concurrent `<XlsxEditor>` instances on
 * the same workbook by parsing an optional `fileId:actor` suffix (`alice`,
 * `bob`, `viewer`) while sharing one authoritative log and stream fan-out.
 */

type ActorConfig = { userId: string; name: string; canEdit: boolean }

export class FakeEventSource extends EventTarget {
  readyState = 0
  readonly url: string
  private onclose: () => void

  constructor(url: string, onclose: () => void) {
    super()
    this.url = url
    this.onclose = onclose
  }

  emitOpen() {
    if (this.readyState === 2) return
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  emitStream(ev: StreamEvent) {
    if (this.readyState === 2) return
    this.dispatchEvent(new MessageEvent(ev.event, { data: JSON.stringify(ev.data) }))
  }

  emitError() {
    if (this.readyState === 2) return
    this.readyState = 0
    this.dispatchEvent(new Event('error'))
  }

  close() {
    if (this.readyState === 2) return
    this.readyState = 2
    this.onclose()
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createLiveApiHarness(
  initialBytes: Uint8Array,
  opts: { actors?: Record<string, ActorConfig>; flushDelayMs?: number; onSaved?: (bytes: Uint8Array) => unknown } = {},
) {
  const actors: Record<string, ActorConfig> = opts.actors ?? {
    default: { userId: 'alice', name: 'Alice', canEdit: true },
    alice: { userId: 'alice', name: 'Alice', canEdit: true },
    bob: { userId: 'bob', name: 'Bob', canEdit: true },
    viewer: { userId: 'viewer', name: 'Viewer', canEdit: false },
  }
  const flushDelayMs = opts.flushDelayMs ?? 15

  let savedBytes = initialBytes
  let baseSeq = 0
  let headSeq = 0
  let epochSeq = 0
  let entries: LogEntry[] = []
  let offline = false
  let failRead = false
  const peers = new Map<string, Peer>()
  const streams = new Set<{ clientId: string; actorId: string; es: FakeEventSource; timer: ReturnType<typeof setTimeout> | null }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const writtenSnapshots: Uint8Array[] = []
  const presenceUpdates: PresenceUpdate[] = []

  const actorFor = (rawId: string): ActorConfig => {
    const idx = rawId.lastIndexOf(':')
    const key = idx >= 0 ? rawId.slice(idx + 1) : 'default'
    return actors[key] ?? actors.default!
  }

  const broadcast = (ev: StreamEvent) => {
    for (const s of [...streams]) s.es.emitStream(ev)
  }

  async function flushNow() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (headSeq === baseSeq) return
    const wb = openWorkbook(savedBytes)
    for (const e of entries) if (e.seq > baseSeq) applyBody(wb, e.body, seedOf(e.clientId, e.opId))
    prepareSave(wb, createCalc(wb))
    savedBytes = wb.pkg.toBytes()
    writtenSnapshots.push(savedBytes)
    await opts.onSaved?.(savedBytes)
    baseSeq = headSeq
    broadcast({ event: 'saved', data: { seq: headSeq, at: new Date().toISOString() } })
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => {
      void flushNow()
    }, flushDelayMs)
  }

  function replicaBytes() {
    const wb = openWorkbook(savedBytes)
    for (const e of entries) if (e.seq > baseSeq) applyBody(wb, e.body, seedOf(e.clientId, e.opId))
    return wb
  }

  const api = {
    async readBytes(_id: string): Promise<Uint8Array> {
      if (failRead) throw new Error('Failed to load file bytes')
      return savedBytes
    },
    async writeBytes(_id: string, bytes: Uint8Array): Promise<{ file: DriveItem }> {
      savedBytes = bytes
      writtenSnapshots.push(bytes)
      return { file: { id: _id, type: 'file', name: 'Workbook.xlsx' } as DriveItem }
    },
    async sheetLiveJoin(id: string): Promise<JoinView> {
      const actor = actorFor(id)
      return {
        baseSha256: await sha256(savedBytes),
        baseSeq,
        head: headSeq,
        entries: entries.filter((e) => e.seq > baseSeq).map((e) => structuredClone(e)),
        canEdit: actor.canEdit,
        peers: [...peers.values()].map((p) => ({ ...p })),
      }
    },
    async sheetLiveSubmit(id: string, req: SubmitRequest): Promise<SubmitResponse> {
      if (offline) throw new Error('Network offline')
      const actor = actorFor(id)
      if (!actor.canEdit) throw new Error('You can only view this file.')
      if (req.baseSeq < epochSeq || req.baseSeq > headSeq) {
        return { state: 'reload', reason: 'The file was replaced outside the co-editing session.' }
      }
      const first = req.changes[0]
      if (first) {
        const had = entries.find((e) => e.clientId === req.clientId && e.opId === first.opId)
        if (had) {
          return {
            state: 'ok',
            accepted: req.changes
              .map((c) => {
                const found = entries.find((e) => e.clientId === req.clientId && e.opId === c.opId)
                return found ? { opId: c.opId, seq: found.seq } : null
              })
              .filter((x): x is { opId: string; seq: number } => x !== null),
            rejected: [],
            head: headSeq,
          }
        }
      }
      const since = entries.filter((e) => e.seq > req.baseSeq).map((e) => e.body)
      const { kept: items, refused } = rebaseItems(req.changes, since)
      const kept = new Set(items.map((i) => i.opId))
      const rejected = req.changes
        .filter((c) => !kept.has(c.opId))
        .map((c) => ({
          opId: c.opId,
          error: refused.find((x) => x.item.opId === c.opId)?.reason ?? 'It no longer applies after the others’ changes.',
        }))

      const wb = replicaBytes()
      const accepted: Array<{ opId: string; seq: number }> = []
      const newEntries: LogEntry[] = []
      for (const it of items) {
        try {
          applyBody(wb, it.body, seedOf(req.clientId, it.opId))
        } catch (err) {
          rejected.push({ opId: it.opId, error: err instanceof Error ? err.message : String(err) })
          continue
        }
        headSeq++
        const entry: LogEntry = {
          seq: headSeq,
          clientId: req.clientId,
          opId: it.opId,
          author: { kind: 'user', id: actor.userId, name: actor.name },
          body: structuredClone(it.body),
          at: new Date().toISOString(),
        }
        entries.push(entry)
        newEntries.push(entry)
        accepted.push({ opId: it.opId, seq: headSeq })
      }
      if (newEntries.length > 0) {
        for (const e of newEntries) broadcast({ event: 'entry', data: structuredClone(e) })
        scheduleFlush()
      }
      return { state: 'ok', accepted, rejected, head: headSeq }
    },
    async sheetLiveEntries(_id: string, after: number): Promise<LogEntry[]> {
      if (offline) throw new Error('Network offline')
      return entries.filter((e) => e.seq > after).map((e) => structuredClone(e))
    },
    async sheetLivePresence(_id: string, update: PresenceUpdate): Promise<{ ok: true }> {
      if (offline) throw new Error('Network offline')
      presenceUpdates.push(update)
      const cur = peers.get(update.clientId)
      if (cur) {
        peers.set(update.clientId, { ...cur, sheet: update.sheet, range: update.range })
        broadcast({ event: 'peers', data: [...peers.values()].map((p) => ({ ...p })) })
      }
      return { ok: true }
    },
    sheetLiveStream(id: string, clientId: string, after: number): EventSource {
      const actor = actorFor(id)
      const peer: Peer = {
        clientId,
        userId: actor.userId,
        name: actor.name,
        color: peerColor(actor.userId),
        sheet: null,
        range: null,
        editing: actor.canEdit,
      }
      peers.set(clientId, peer)
      const rec: { clientId: string; actorId: string; es: FakeEventSource; timer: ReturnType<typeof setTimeout> | null } = {
        clientId,
        actorId: id,
        es: null as unknown as FakeEventSource,
        timer: null,
      }
      const es = new FakeEventSource(
        `/api/drive/files/${id}/sheet-live/stream?clientId=${encodeURIComponent(clientId)}&after=${after}`,
        () => {
          if (rec.timer) clearTimeout(rec.timer)
          streams.delete(rec)
          peers.delete(clientId)
          broadcast({ event: 'peers', data: [...peers.values()].map((p) => ({ ...p })) })
        },
      )
      rec.es = es
      streams.add(rec)
      rec.timer = setTimeout(() => {
        rec.timer = null
        if (es.readyState === 2) return
        es.emitOpen()
        const peerList = [...peers.values()].map((p) => ({ ...p }))
        broadcast({ event: 'peers', data: peerList })
        for (const e of entries.filter((x) => x.seq > after)) {
          es.emitStream({ event: 'entry', data: structuredClone(e) })
        }
      }, 0)
      return es as unknown as EventSource
    },
  }

  return {
    api,
    /** Writes pending log ops to bytes immediately and returns the authoritative workbook. */
    async savedBook() {
      await flushNow()
      return openWorkbook(savedBytes)
    },
    savedCount: () => writtenSnapshots.length,
    presenceCount: () => presenceUpdates.length,
    entries: () => entries.map((e) => ({ ...e })),
    peers: () => [...peers.values()],
    headSeq: () => headSeq,
    setOffline(next: boolean, notifyStreams = true) {
      offline = next
      if (!notifyStreams) return
      if (next) for (const s of [...streams]) s.es.emitError()
      else for (const s of [...streams]) s.es.emitOpen()
    },
    setFailRead(next: boolean) {
      failRead = next
    },
    /** Simulates an external file upload or revision restore outside co-editing. */
    replaceExternally(nextBytes: Uint8Array) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      savedBytes = nextBytes
      baseSeq = headSeq
      epochSeq = headSeq
      broadcast({ event: 'reset', data: { reason: 'The file was replaced outside the co-editing session.' } })
    },
    reset(nextBytes: Uint8Array) {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      for (const s of [...streams]) s.es.close()
      savedBytes = nextBytes
      baseSeq = 0
      headSeq = 0
      epochSeq = 0
      entries = []
      offline = false
      failRead = false
      peers.clear()
      writtenSnapshots.length = 0
      presenceUpdates.length = 0
    },
    canonicalSame: (a: unknown, b: unknown) => canonical(a) === canonical(b),
  }
}

type Harness = ReturnType<typeof createLiveApiHarness>
/** The Drive's plain read and write, as specs written before co-editing mock them. */
type PlainApi = {
  readBytes: (id: string) => Promise<Uint8Array>
  writeBytes: (id: string, bytes: Uint8Array, session: string, base?: string) => Promise<unknown>
}
const plainSlots = new WeakMap<object, { h: Harness | null; fileId: string | null }>()

/**
 * The live APIs for specs that mock the Drive's plain `readBytes` and
 * `writeBytes`: the session starts from what `readBytes(fileId)` gives, and
 * every save of the session is a `writeBytes` call — so a spec's saved-file
 * assertions keep checking what the server writes. Other files (a picture
 * picked from Drive) are read through the spec's `readBytes` as before.
 */
export function liveOverPlainApi(fns: PlainApi) {
  const slot = { h: null as Harness | null, fileId: null as string | null }
  plainSlots.set(fns, slot)
  const harness = async (id: string) => {
    if (!slot.h) {
      const start = await fns.readBytes(id)
      slot.fileId = id
      slot.h = createLiveApiHarness(start, { onSaved: (bytes) => fns.writeBytes(id, bytes, 'sheet-live:' + id, undefined) })
    }
    return slot.h
  }
  return {
    readBytes: (id: string) => (slot.h && id === slot.fileId ? slot.h.api.readBytes(id) : fns.readBytes(id)),
    sheetLiveJoin: async (id: string) => (await harness(id)).api.sheetLiveJoin(id),
    sheetLiveSubmit: async (id: string, req: SubmitRequest) => (await harness(id)).api.sheetLiveSubmit(id, req),
    sheetLiveEntries: async (id: string, after: number) => (await harness(id)).api.sheetLiveEntries(id, after),
    sheetLivePresence: async (id: string, update: PresenceUpdate) => (await harness(id)).api.sheetLivePresence(id, update),
    sheetLiveStream: (id: string, clientId: string, after: number) => {
      if (!slot.h) throw new Error('sheetLiveStream before sheetLiveJoin')
      return slot.h.api.sheetLiveStream(id, clientId, after)
    },
  }
}

/** Between tests: the next join starts a fresh session from the spec's `readBytes`. */
export function resetPlainLive(fns: PlainApi) {
  const slot = plainSlots.get(fns)
  if (!slot) return
  slot.h?.reset(new Uint8Array())
  slot.h = null
  slot.fileId = null
}
