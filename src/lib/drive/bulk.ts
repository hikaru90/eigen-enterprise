import { m } from '$lib/paraglide/messages.js'
import { driveApi, type GrantEntry, type ItemRef } from './api'
import { runBatch, selKey, type BatchResult, type BulkAction } from './selection'

/**
 * The selection bar's acts as bulk tool calls (drive.*_many through
 * /api/drive/batch/*, archive/unarchive through /api/drive/archive) and
 * what the person is told afterwards: how many were done, and every item
 * that wasn't with its reason — never swallowed.
 */

export type BulkRequest =
  | { action: 'move'; folderId: string | null }
  | { action: 'share'; grants: GrantEntry[] }
  | { action: Exclude<BulkAction, 'move' | 'share'> }

type Answer = { done: number; errors: BatchResult['errors'] }
const counted =
  <K extends string>(key: K) =>
  (out: Record<K, unknown[]> & { errors: BatchResult['errors'] }): Answer => ({
    done: out[key].length,
    errors: out.errors,
  })

function callFor(req: BulkRequest): (chunk: ItemRef[]) => Promise<Answer> {
  switch (req.action) {
    case 'move':
      return (c) => driveApi.moveMany(c, req.folderId).then(counted('moved'))
    case 'share':
      return (c) => driveApi.shareMany(c, req.grants).then(counted('shared'))
    case 'archive':
      return (c) => driveApi.archiveMany(c).then(counted('archived'))
    case 'unarchive':
      return (c) => driveApi.unarchiveMany(c).then(counted('unarchived'))
    case 'trash':
      return (c) => driveApi.trashMany(c).then(counted('trashed'))
    case 'restore':
      return (c) => driveApi.restoreMany(c).then(counted('restored'))
    case 'delete_forever':
      return (c) => driveApi.deleteForeverMany(c).then(counted('deleted'))
  }
}

export function runBulk(req: BulkRequest, items: readonly ItemRef[]): Promise<BatchResult> {
  const refs = items.map((i) => ({ type: i.type, id: i.id }))
  return runBatch(refs, callFor(req))
}

export const BULK_LABEL: Record<BulkAction, () => string> = {
  move: m.drive_bulk_move,
  share: m.drive_bulk_share,
  archive: m.drive_bulk_archive,
  unarchive: m.drive_bulk_unarchive,
  trash: m.drive_bulk_trash,
  restore: m.drive_bulk_restore,
  delete_forever: m.drive_bulk_delete_forever,
}

const DONE: Record<BulkAction, (p: { count: number }) => string> = {
  move: m.drive_bulk_done_move,
  share: m.drive_bulk_done_share,
  archive: m.drive_bulk_done_archive,
  unarchive: m.drive_bulk_done_unarchive,
  trash: m.drive_bulk_done_trash,
  restore: m.drive_bulk_done_restore,
  delete_forever: m.drive_bulk_done_delete_forever,
}

export const confirmDeleteText = (count: number) =>
  count === 1 ? m.drive_bulk_confirm_delete_one() : m.drive_bulk_confirm_delete_many({ count })

/** What the person reads after a bulk act: "3 moved", or "3 moved, 1 failed:" with each failed item and why. */
export type BulkOutcome = {
  /** Set when everything asked was done. */
  notice: string | null
  /** Set when some items failed: the heading and one row per item. */
  failed: { heading: string; rows: Array<{ key: string; name: string; reason: string }> } | null
  /** A call that failed as a whole (the rest were not sent). */
  stopped: string | null
  /** The keys of the items that failed (they stay selected). */
  failedKeys: Set<string>
}

export function bulkOutcome(
  action: BulkAction,
  out: BatchResult,
  nameOf: (ref: ItemRef) => string,
): BulkOutcome {
  const done = DONE[action]({ count: out.done })
  const rows = out.errors.map((e) => ({ key: selKey(e), name: nameOf(e), reason: e.error }))
  return {
    notice: rows.length === 0 && !out.stopped ? done : null,
    failed:
      rows.length > 0 || out.stopped
        ? { heading: `${done}${rows.length > 0 ? `, ${m.drive_bulk_failed({ count: rows.length })}` : ''}`, rows }
        : null,
    stopped: out.stopped
      ? m.drive_bulk_stopped({ error: out.stopped.error, count: out.stopped.notTried })
      : null,
    failedKeys: new Set(rows.map((r) => r.key)),
  }
}
