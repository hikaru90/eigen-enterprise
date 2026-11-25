import { describe, expect, it, vi } from 'vitest'
import {
  bulkActions,
  clickSelect,
  headerState,
  keepOnly,
  runBatch,
  selKey,
  toggleAll,
} from './selection'

const keys = ['folder:a', 'file:b', 'file:c', 'file:d', 'file:e']

describe('selKey', () => {
  it('keys an item by type and id', () => {
    expect(selKey({ type: 'folder', id: 'a' })).toBe('folder:a')
  })
})

describe('clickSelect', () => {
  it('toggles one key and makes it the anchor', () => {
    const one = clickSelect({ keys: new Set(), anchor: null }, keys, 'file:b', false)
    expect([...one.keys]).toEqual(['file:b'])
    expect(one.anchor).toBe('file:b')
    const off = clickSelect(one, keys, 'file:b', false)
    expect([...off.keys]).toEqual([])
  })

  it('shift-click sets every key from the anchor to the clicked one, in list order, either direction', () => {
    const start = clickSelect({ keys: new Set(), anchor: null }, keys, 'file:b', false)
    const down = clickSelect(start, keys, 'file:d', true)
    expect([...down.keys].sort()).toEqual(['file:b', 'file:c', 'file:d'])
    const up = clickSelect({ keys: new Set(), anchor: 'file:d' }, keys, 'folder:a', true)
    expect([...up.keys].sort()).toEqual(['file:b', 'file:c', 'file:d', 'folder:a'])
  })

  it('shift-click on a selected key clears the range (it follows the clicked row’s new state)', () => {
    const all = { keys: new Set(keys), anchor: 'file:b' }
    const cleared = clickSelect(all, keys, 'file:d', true)
    expect([...cleared.keys].sort()).toEqual(['file:e', 'folder:a'])
  })

  it('shift-click without an anchor still in the list is a plain toggle', () => {
    const out = clickSelect({ keys: new Set(), anchor: 'file:gone' }, keys, 'file:c', true)
    expect([...out.keys]).toEqual(['file:c'])
  })
})

describe('headerState / toggleAll (the current page)', () => {
  const page = ['file:b', 'file:c']
  it('is none, some or all of the page', () => {
    expect(headerState(new Set(), page)).toBe('none')
    expect(headerState(new Set(['file:b', 'file:e']), page)).toBe('some')
    expect(headerState(new Set(page), page)).toBe('all')
    expect(headerState(new Set(), [])).toBe('none')
  })

  it('selects the whole page, or (when all of it is selected) clears just the page', () => {
    expect([...toggleAll(new Set(['file:e']), page)].sort()).toEqual(['file:b', 'file:c', 'file:e'])
    expect([...toggleAll(new Set(['file:b']), page)].sort()).toEqual(['file:b', 'file:c'])
    expect([...toggleAll(new Set(['file:b', 'file:c', 'file:e']), page)]).toEqual(['file:e'])
  })
})

describe('keepOnly', () => {
  it('drops keys no longer listed and keeps the same set when nothing changed', () => {
    const sel = new Set(['file:b', 'file:gone'])
    expect([...keepOnly(sel, keys)]).toEqual(['file:b'])
    const same = new Set(['file:b'])
    expect(keepOnly(same, keys)).toBe(same)
  })
})

describe('bulkActions: only what is valid for every selected item', () => {
  const edit = { canEdit: true, canManage: false }
  const manage = { canEdit: true, canManage: true }
  const view = { canEdit: false, canManage: false }

  it('offers nothing for an empty selection', () => {
    expect(bulkActions([], 'drive')).toEqual([])
  })

  it('drive: move, archive, trash need edit on all; share needs manage on all', () => {
    expect(bulkActions([manage, manage], 'drive')).toEqual(['move', 'share', 'archive', 'trash'])
    expect(bulkActions([manage, edit], 'drive')).toEqual(['move', 'archive', 'trash'])
    expect(bulkActions([manage, view], 'drive')).toEqual([])
  })

  it('drive: archived search results offer unarchive; a mix of archived and not offers neither', () => {
    const archived = { ...edit, archivedAt: '2026-11-01' }
    expect(bulkActions([archived, archived], 'drive')).toEqual(['move', 'unarchive', 'trash'])
    expect(bulkActions([archived, edit], 'drive')).toEqual(['move', 'trash'])
  })

  it('trash: restore for all; delete forever only when every item may be managed', () => {
    expect(bulkActions([manage, manage], 'trash')).toEqual(['restore', 'delete_forever'])
    expect(bulkActions([manage, edit], 'trash')).toEqual(['restore'])
  })

  it('archived: unarchive needs edit on all', () => {
    expect(bulkActions([edit, manage], 'archived')).toEqual(['unarchive'])
    expect(bulkActions([edit, view], 'archived')).toEqual([])
  })
})

describe('runBatch', () => {
  const items = Array.from({ length: 250 }, (_, i) => ({ type: 'file' as const, id: `f${i}` }))

  it('sends the selection in chunks of 100 and adds up what was done and every per-item error', async () => {
    const call = vi.fn(async (chunk: typeof items) => ({
      done: chunk.length - 1,
      errors: [{ ...chunk[0]!, error: 'nope' }],
    }))
    const out = await runBatch(items, call)
    expect(call.mock.calls.map(([c]) => c.length)).toEqual([100, 100, 50])
    expect(out).toEqual({
      done: 247,
      errors: [
        { type: 'file', id: 'f0', error: 'nope' },
        { type: 'file', id: 'f100', error: 'nope' },
        { type: 'file', id: 'f200', error: 'nope' },
      ],
      stopped: null,
    })
  })

  it('stops at a call that fails as a whole and says how many were not tried (never swallowed)', async () => {
    let n = 0
    const call = vi.fn(async (chunk: typeof items) => {
      if (++n === 2) throw new Error('The folder is gone.')
      return { done: chunk.length, errors: [] }
    })
    const out = await runBatch(items, call)
    expect(out).toEqual({ done: 100, errors: [], stopped: { error: 'The folder is gone.', notTried: 150 } })
    expect(call).toHaveBeenCalledTimes(2)
  })
})
