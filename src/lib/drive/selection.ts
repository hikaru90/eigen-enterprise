/**
 * Row selection in Drive's lists (pure view state): which rows are ticked,
 * shift-click ranges, the header checkbox over the current page, the acts
 * valid for every selected item, and sending a selection to a bulk tool in
 * chunks. Rows are keyed `type:id` (a file and a folder may share an id).
 */

export type ItemRef = { type: 'file' | 'folder'; id: string }
export type Selection = { keys: ReadonlySet<string>; anchor: string | null }
export type HeaderState = 'none' | 'some' | 'all'
/** Which list the selection is in: the acts differ (Trash restores, Archived unarchives). */
export type SelectionView = 'drive' | 'trash' | 'archived'
export type BulkAction =
  | 'move'
  | 'share'
  | 'archive'
  | 'unarchive'
  | 'trash'
  | 'restore'
  | 'delete_forever'

export const selKey = (item: ItemRef): string => `${item.type}:${item.id}`

/**
 * A click on a row's checkbox: toggles that row and makes it the anchor; with
 * shift, every row from the anchor to it (in `ordered`, the list as shown)
 * takes the clicked row's new state.
 */
export function clickSelect(
  sel: Selection,
  ordered: readonly string[],
  key: string,
  shift: boolean,
): Selection {
  const on = !sel.keys.has(key)
  const next = new Set(sel.keys)
  const from = sel.anchor === null ? -1 : ordered.indexOf(sel.anchor)
  const to = ordered.indexOf(key)
  if (shift && from >= 0 && to >= 0) {
    const [lo, hi] = from < to ? [from, to] : [to, from]
    for (const k of ordered.slice(lo, hi + 1)) {
      if (on) next.add(k)
      else next.delete(k)
    }
  } else if (on) next.add(key)
  else next.delete(key)
  return { keys: next, anchor: key }
}

/** The header checkbox over the current page. */
export function headerState(keys: ReadonlySet<string>, page: readonly string[]): HeaderState {
  const picked = page.filter((k) => keys.has(k)).length
  if (picked === 0) return 'none'
  return picked === page.length ? 'all' : 'some'
}

/** The header checkbox's click: select the whole page, or clear the page when all of it is selected. */
export function toggleAll(keys: ReadonlySet<string>, page: readonly string[]): Set<string> {
  const next = new Set(keys)
  if (headerState(keys, page) === 'all') for (const k of page) next.delete(k)
  else for (const k of page) next.add(k)
  return next
}

/** Only the keys still listed (after a filter or a reload); the same set when none went. */
export function keepOnly(keys: ReadonlySet<string>, listed: readonly string[]): ReadonlySet<string> {
  const present = new Set(listed)
  if ([...keys].every((k) => present.has(k))) return keys
  return new Set([...keys].filter((k) => present.has(k)))
}

type Rights = { canEdit?: boolean; canManage?: boolean; archivedAt?: string | Date | null }

/**
 * The acts valid for every selected item, in bar order. An act some item
 * can't take is left out rather than failing for that item (the server
 * still checks each one).
 */
export function bulkActions(items: readonly Rights[], view: SelectionView): BulkAction[] {
  if (items.length === 0) return []
  const all = (p: (i: Rights) => boolean) => items.every(p)
  const edit = all((i) => i.canEdit === true)
  const manage = all((i) => i.canManage === true)
  const out: BulkAction[] = []
  if (view === 'trash') {
    out.push('restore')
    if (manage) out.push('delete_forever')
    return out
  }
  if (view === 'archived') return edit ? ['unarchive'] : []
  if (edit) out.push('move')
  if (manage) out.push('share')
  if (edit && all((i) => !i.archivedAt)) out.push('archive')
  if (edit && all((i) => !!i.archivedAt)) out.push('unarchive')
  if (edit) out.push('trash')
  return out
}

/** One bulk tool call's per-item answer. */
export type BatchError = ItemRef & { error: string }
export type BatchResult = {
  done: number
  errors: BatchError[]
  /** A call that failed as a whole: its sentence, and how many items were never sent. */
  stopped: { error: string; notTried: number } | null
}

/** Items per bulk call: the bulk tools' limit (one approval each). */
export const BATCH_SIZE = 100

/** Sends the items in chunks and adds up the answers; stops at a call that fails as a whole. */
export async function runBatch<T extends ItemRef>(
  items: readonly T[],
  call: (chunk: T[]) => Promise<{ done: number; errors: BatchError[] }>,
): Promise<BatchResult> {
  let done = 0
  const errors: BatchError[] = []
  for (let at = 0; at < items.length; at += BATCH_SIZE) {
    const chunk = items.slice(at, at + BATCH_SIZE)
    try {
      const out = await call(chunk)
      done += out.done
      errors.push(...out.errors)
    } catch (err) {
      return {
        done,
        errors,
        stopped: { error: err instanceof Error ? err.message : String(err), notTried: items.length - at },
      }
    }
  }
  return { done, errors, stopped: null }
}
