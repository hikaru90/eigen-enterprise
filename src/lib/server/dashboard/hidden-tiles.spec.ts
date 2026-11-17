import { describe, expect, it, vi } from 'vitest'

const getDbMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))

import { getHiddenTiles, saveHiddenTiles } from './hidden-tiles'

function selectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = () => chain
  chain.where = () => chain
  chain.limit = () => Promise.resolve(rows)
  return chain
}

describe('hidden dashboard tiles', () => {
  it('reads the tiles a person closed; none before they ever closed one', async () => {
    getDbMock.mockReturnValue(selectChain([{ hidden: ['apps'] }]))
    expect(await getHiddenTiles('u1')).toEqual(['apps'])
    getDbMock.mockReturnValue(selectChain([]))
    expect(await getHiddenTiles('u1')).toEqual([])
  })

  it('fails loud on a stored tile it does not know', async () => {
    getDbMock.mockReturnValue(selectChain([{ hidden: ['weather'] }]))
    await expect(getHiddenTiles('u1')).rejects.toThrow('unknown dashboard tile "weather"')
  })

  it('saves them as the person’s preference (upsert)', async () => {
    const captured: { values?: unknown; set?: unknown } = {}
    const chain = {
      insert: () => chain,
      values(values: unknown) {
        captured.values = values
        return chain
      },
      onConflictDoUpdate(arg: { set: unknown }) {
        captured.set = arg.set
        return Promise.resolve()
      },
    }
    getDbMock.mockReturnValue(chain)
    await saveHiddenTiles('u1', ['ask', 'apps'])
    expect(captured.values).toEqual({ userId: 'u1', dashboardHiddenTiles: ['ask', 'apps'] })
    expect(captured.set).toMatchObject({ dashboardHiddenTiles: ['ask', 'apps'] })
  })
})
