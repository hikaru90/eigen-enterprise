import type { SessionRow, SheetLiveStore, SheetLiveTx } from './store'
import { and, asc, eq, gt, gte, lt, lte, sql } from 'drizzle-orm'
import type { Peer } from '$lib/office/xlsx/collab/protocol'
import type { AppDatabase } from '$lib/server/db/context'
import { sheetLiveEntry, sheetLivePeer, sheetLiveSession } from '$lib/server/db/sheet-live.schema'

/** Postgres NOTIFY channel every app process LISTENs on for live workbook updates. */
export const SHEET_LIVE_NOTIFY_CHANNEL = 'ee_sheet_live'

const INSERT_CHUNK = 500
const PG_INT4_MAX = 2_147_483_647

type SheetLiveDatabase = Pick<AppDatabase, 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'transaction'>

async function sheetLiveDb(): Promise<AppDatabase> {
  const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
  return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
}

function toSessionRow(r: typeof sheetLiveSession.$inferSelect): SessionRow {
  return {
    fileId: r.fileId,
    baseSha256: r.baseSha256,
    baseSeq: r.baseSeq,
    headSeq: r.headSeq,
    epochSeq: r.epochSeq,
    updatedAt: r.updatedAt,
    savedAt: r.savedAt,
  }
}

function toLogEntry(r: typeof sheetLiveEntry.$inferSelect) {
  return {
    seq: r.seq,
    clientId: r.clientId,
    opId: r.opId,
    author: r.author,
    body: r.body,
    at: r.at.toISOString(),
  }
}

function toPeer(r: typeof sheetLivePeer.$inferSelect): Peer {
  return {
    clientId: r.clientId,
    userId: r.userId,
    name: r.name,
    color: r.color,
    sheet: r.sheet,
    range: r.range,
    editing: r.editing,
  }
}

async function queryEntriesAfter(db: SheetLiveDatabase, fileId: string, seq: number, limit?: number) {
  const base = db
    .select()
    .from(sheetLiveEntry)
    .where(and(eq(sheetLiveEntry.fileId, fileId), gt(sheetLiveEntry.seq, seq)))
    .orderBy(asc(sheetLiveEntry.seq))
  const rows =
    limit !== undefined && Number.isFinite(limit) && limit < PG_INT4_MAX ? await base.limit(Math.max(0, limit)) : await base
  return rows.map(toLogEntry)
}

function txFor(db: SheetLiveDatabase, fileId: string): SheetLiveTx {
  return {
    async session() {
      const [row] = await db.select().from(sheetLiveSession).where(eq(sheetLiveSession.fileId, fileId)).limit(1)
      return row ? toSessionRow(row) : null
    },
    async putSession(row) {
      await db
        .insert(sheetLiveSession)
        .values(row)
        .onConflictDoUpdate({
          target: sheetLiveSession.fileId,
          set: {
            baseSha256: row.baseSha256,
            baseSeq: row.baseSeq,
            headSeq: row.headSeq,
            epochSeq: row.epochSeq,
            updatedAt: row.updatedAt,
            savedAt: row.savedAt,
          },
        })
    },
    async entriesAfter(seq, limit) {
      return queryEntriesAfter(db, fileId, seq, limit)
    },
    async findEntry(clientId, opId) {
      const [row] = await db
        .select()
        .from(sheetLiveEntry)
        .where(and(eq(sheetLiveEntry.fileId, fileId), eq(sheetLiveEntry.clientId, clientId), eq(sheetLiveEntry.opId, opId)))
        .limit(1)
      return row ? toLogEntry(row) : null
    },
    async append(entries) {
      for (let i = 0; i < entries.length; i += INSERT_CHUNK) {
        const chunk = entries.slice(i, i + INSERT_CHUNK)
        await db.insert(sheetLiveEntry).values(
          chunk.map((e) => ({
            fileId,
            seq: e.seq,
            clientId: e.clientId,
            opId: e.opId,
            author: e.author,
            body: e.body,
            at: new Date(e.at),
          })),
        )
      }
    },
    async prune(seq, before) {
      await db
        .delete(sheetLiveEntry)
        .where(and(eq(sheetLiveEntry.fileId, fileId), lte(sheetLiveEntry.seq, seq), lt(sheetLiveEntry.at, before)))
    },
  }
}

/**
 * Co-editing workbook store backed by Postgres (migration 0186). `locked` takes a
 * transaction-scoped advisory lock per file so every web/CLI process serializes
 * changes for that workbook without contending across different workbooks.
 */
export function makeDbSheetLiveStore(resolveDb: () => Promise<SheetLiveDatabase> | SheetLiveDatabase): SheetLiveStore {
  return {
    async locked(fileId, work) {
      const db = await resolveDb()
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'sheet_live'}), hashtext(${fileId}))`)
        return work(txFor(tx, fileId))
      })
    },
    async entriesAfter(fileId, seq, limit) {
      return queryEntriesAfter(await resolveDb(), fileId, seq, limit)
    },
    async session(fileId) {
      const db = await resolveDb()
      const [row] = await db.select().from(sheetLiveSession).where(eq(sheetLiveSession.fileId, fileId)).limit(1)
      return row ? toSessionRow(row) : null
    },
    async unsaved(before) {
      const db = await resolveDb()
      const rows = await db
        .select({ fileId: sheetLiveSession.fileId })
        .from(sheetLiveSession)
        .where(and(gt(sheetLiveSession.headSeq, sheetLiveSession.baseSeq), lt(sheetLiveSession.updatedAt, before)))
      return rows.map((r) => r.fileId)
    },
    async putPeer(fileId, peer, at) {
      const db = await resolveDb()
      await db
        .insert(sheetLivePeer)
        .values({
          fileId,
          clientId: peer.clientId,
          userId: peer.userId,
          name: peer.name,
          color: peer.color,
          sheet: peer.sheet,
          range: peer.range,
          editing: peer.editing,
          updatedAt: at,
        })
        .onConflictDoUpdate({
          target: [sheetLivePeer.fileId, sheetLivePeer.clientId],
          set: {
            userId: peer.userId,
            name: peer.name,
            color: peer.color,
            sheet: peer.sheet,
            range: peer.range,
            editing: peer.editing,
            updatedAt: at,
          },
        })
    },
    async removePeer(fileId, clientId) {
      const db = await resolveDb()
      await db.delete(sheetLivePeer).where(and(eq(sheetLivePeer.fileId, fileId), eq(sheetLivePeer.clientId, clientId)))
    },
    async livePeers(fileId, since) {
      const db = await resolveDb()
      const rows = await db
        .select()
        .from(sheetLivePeer)
        .where(and(eq(sheetLivePeer.fileId, fileId), gte(sheetLivePeer.updatedAt, since)))
        .orderBy(asc(sheetLivePeer.clientId))
      return rows.map(toPeer)
    },
    async findPeer(fileId, clientId) {
      const db = await resolveDb()
      const [row] = await db
        .select()
        .from(sheetLivePeer)
        .where(and(eq(sheetLivePeer.fileId, fileId), eq(sheetLivePeer.clientId, clientId)))
        .limit(1)
      return row ? toPeer(row) : null
    },
    async prunePeers(before) {
      const db = await resolveDb()
      await db.delete(sheetLivePeer).where(lt(sheetLivePeer.updatedAt, before))
    },
  }
}

export const dbSheetLiveStore = makeDbSheetLiveStore(sheetLiveDb)
