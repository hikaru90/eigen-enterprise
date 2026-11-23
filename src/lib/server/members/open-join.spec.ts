import { describe, expect, it, vi } from 'vitest'
import { memoryOpenJoinStore, openJoinOffMessage, readOpenJoin, setOpenJoin } from './open-join'

function setup(initial = false) {
  const store = memoryOpenJoinStore(initial)
  const audit = vi.fn(async () => {})
  return { store, audit, deps: { store, audit } }
}

describe('open join (members.open_join)', () => {
  it('is off by default', async () => {
    const { deps } = setup()
    expect(await readOpenJoin({ id: 'o', role: 'owner' }, deps)).toEqual({ openJoin: false })
  })

  it('the owner and an admin switch it; each switch is audited with who did it', async () => {
    const { deps, audit, store } = setup()
    expect(await setOpenJoin({ id: 'o', role: 'owner' }, { on: true }, deps)).toEqual({ openJoin: true })
    expect(store.updatedBy).toBe('o')
    expect(await setOpenJoin({ id: 'a', role: 'admin' }, { on: false }, deps)).toEqual({ openJoin: false })
    expect(await store.get()).toBe(false)
    expect(audit.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      { type: 'members.open_join_changed', principalId: 'o', payload: { openJoin: true, was: false } },
      { type: 'members.open_join_changed', principalId: 'a', payload: { openJoin: false, was: true } },
    ])
  })

  it('a member neither reads nor switches it, and nothing is written', async () => {
    const { deps, audit, store } = setup()
    await expect(readOpenJoin({ id: 'm', role: 'member' }, deps)).rejects.toThrow(/owner or an admin/)
    await expect(setOpenJoin({ id: 'm', role: 'member' }, { on: true }, deps)).rejects.toThrow(/owner or an admin/)
    await expect(setOpenJoin({ id: 'x', role: null }, { on: true }, deps)).rejects.toThrow(/owner or an admin/)
    expect(await store.get()).toBe(false)
    expect(audit).not.toHaveBeenCalled()
  })

  it('says plainly when the company is not open to join', () => {
    expect(openJoinOffMessage('Northwind')).toBe('Northwind is not open to join. Ask the owner for an invite.')
    expect(openJoinOffMessage(null)).toMatch(/^This company is not open to join/)
  })
})
