import type { LogEntry, Peer } from '$lib/office/xlsx/collab/protocol'

/**
 * The op log of co-edited workbooks (migration 0186): one session row per
 * file and its numbered entries. `baseSeq` is the last entry written into
 * the file (its content's SHA-256 is `baseSha256`); entries after it are
 * not in the file yet. `epochSeq`: entries up to here belong to a file
 * content that was replaced outside the session (a restored revision, an
 * upload) — a client based before it must load the file again.
 */
export type SessionRow = {
  fileId: string
  baseSha256: string
  baseSeq: number
  headSeq: number
  epochSeq: number
  updatedAt: Date
  savedAt: Date | null
}

export type SheetLiveTx = {
  session(): Promise<SessionRow | null>
  putSession(row: SessionRow): Promise<void>
  /** Entries after `seq`, in order (at most `limit`). */
  entriesAfter(seq: number, limit?: number): Promise<LogEntry[]>
  /** The entry `opId` of `clientId`, when logged. */
  findEntry(clientId: string, opId: string): Promise<LogEntry | null>
  append(entries: LogEntry[]): Promise<void>
  /** Drops entries up to `seq` written before `before` (kept a while for clients that come back late). */
  prune(seq: number, before: Date): Promise<void>
}

export type SheetLiveStore = {
  /** Runs `work` alone for this file — one at a time per file, in every app process. */
  locked<T>(fileId: string, work: (tx: SheetLiveTx) => Promise<T>): Promise<T>
  entriesAfter(fileId: string, seq: number, limit: number): Promise<LogEntry[]>
  session(fileId: string): Promise<SessionRow | null>
  /** Files with entries not in the file yet, last changed before `before`. */
  unsaved(before: Date): Promise<string[]>
  /** Records or refreshes one active tab's presence across processes. */
  putPeer(fileId: string, peer: Peer, at: Date): Promise<void>
  removePeer(fileId: string, clientId: string): Promise<void>
  livePeers(fileId: string, since: Date): Promise<Peer[]>
  findPeer(fileId: string, clientId: string): Promise<Peer | null>
  prunePeers(before: Date): Promise<void>
}

/** In memory (tests): a promise chain per file stands for the database's lock. */
export function memorySheetLiveStore(): SheetLiveStore {
  const sessions = new Map<string, SessionRow>()
  const logs = new Map<string, LogEntry[]>()
  const peersByFile = new Map<string, Map<string, { peer: Peer; at: Date }>>()
  const queues = new Map<string, Promise<unknown>>()
  const log = (fileId: string) => logs.get(fileId) ?? []
  const peerMap = (fileId: string) => peersByFile.get(fileId)
  const copy = <T>(v: T): T => structuredClone(v)

  const txFor = (fileId: string): SheetLiveTx => ({
    async session() {
      const s = sessions.get(fileId)
      return s ? { ...s } : null
    },
    async putSession(row) {
      sessions.set(fileId, { ...row })
    },
    async entriesAfter(seq, limit = Number.MAX_SAFE_INTEGER) {
      return copy(log(fileId).filter((e) => e.seq > seq).slice(0, limit))
    },
    async findEntry(clientId, opId) {
      const e = log(fileId).find((x) => x.clientId === clientId && x.opId === opId)
      return e ? copy(e) : null
    },
    async append(entries) {
      logs.set(fileId, [...log(fileId), ...copy(entries)])
    },
    async prune(seq, before) {
      logs.set(
        fileId,
        log(fileId).filter((e) => e.seq > seq || new Date(e.at) >= before),
      )
    },
  })

  return {
    locked(fileId, work) {
      const prev = queues.get(fileId) ?? Promise.resolve()
      const next = prev.catch(() => {}).then(() => work(txFor(fileId)))
      queues.set(fileId, next)
      return next
    },
    async entriesAfter(fileId, seq, limit) {
      return copy(log(fileId).filter((e) => e.seq > seq).slice(0, limit))
    },
    async session(fileId) {
      const s = sessions.get(fileId)
      return s ? { ...s } : null
    },
    async unsaved(before) {
      return [...sessions.values()].filter((s) => s.headSeq > s.baseSeq && s.updatedAt < before).map((s) => s.fileId)
    },
    async putPeer(fileId, peer, at) {
      const map = peerMap(fileId) ?? new Map<string, { peer: Peer; at: Date }>()
      map.set(peer.clientId, { peer: copy(peer), at })
      peersByFile.set(fileId, map)
    },
    async removePeer(fileId, clientId) {
      peerMap(fileId)?.delete(clientId)
    },
    async livePeers(fileId, since) {
      const map = peerMap(fileId)
      if (!map) return []
      return [...map.values()].filter((x) => x.at >= since).map((x) => copy(x.peer))
    },
    async findPeer(fileId, clientId) {
      const found = peerMap(fileId)?.get(clientId)
      return found ? copy(found.peer) : null
    },
    async prunePeers(before) {
      for (const [fileId, map] of peersByFile) {
        for (const [clientId, entry] of map) if (entry.at < before) map.delete(clientId)
        if (map.size === 0) peersByFile.delete(fileId)
      }
    },
  }
}
