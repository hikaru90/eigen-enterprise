import { describe, expect, it } from 'vitest'
import { CoworkerDelegationError, MAX_DELEGATION_HOPS, nextDelegationChain } from './delegation'

describe('nextDelegationChain (co-worker → co-worker task chains)', () => {
  it('a person assigning starts no chain', () => {
    expect(nextDelegationChain({ assigner: { id: 'ann', kind: 'human' }, assigneeId: 'mkt', assignerRunChains: [] })).toEqual([])
  })

  it('a co-worker assigning adds itself to the chain of the work it is doing', () => {
    expect(nextDelegationChain({ assigner: { id: 'mkt', kind: 'coworker' }, assigneeId: 'gtm', assignerRunChains: [[]] })).toEqual(['mkt'])
    expect(nextDelegationChain({ assigner: { id: 'gtm', kind: 'coworker' }, assigneeId: 'des', assignerRunChains: [['mkt']] })).toEqual(['mkt', 'gtm'])
  })

  it(`allows ${MAX_DELEGATION_HOPS} co-worker hops and refuses the next, naming the limit`, () => {
    const full = ['a', 'b', 'c'].slice(0, MAX_DELEGATION_HOPS - 1)
    expect(nextDelegationChain({ assigner: { id: 'x', kind: 'coworker' }, assigneeId: 'y', assignerRunChains: [full] })).toHaveLength(MAX_DELEGATION_HOPS)
    const err = (() => {
      try {
        nextDelegationChain({ assigner: { id: 'x', kind: 'coworker' }, assigneeId: 'y', assignerRunChains: [[...full, 'z']] })
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(CoworkerDelegationError)
    expect((err as CoworkerDelegationError).reason).toBe('depth')
    expect((err as Error).message).toContain(String(MAX_DELEGATION_HOPS))
  })

  it('refuses handing work back to a co-worker already in the chain (a loop)', () => {
    expect(() => nextDelegationChain({ assigner: { id: 'gtm', kind: 'coworker' }, assigneeId: 'mkt', assignerRunChains: [['mkt']] })).toThrow(
      expect.objectContaining({ reason: 'cycle' }),
    )
  })

  it('with several running runs, the longest chain counts (the safe side)', () => {
    expect(() =>
      nextDelegationChain({ assigner: { id: 'x', kind: 'coworker' }, assigneeId: 'y', assignerRunChains: [[], ['a', 'b', 'c'].slice(0, MAX_DELEGATION_HOPS)] }),
    ).toThrow(expect.objectContaining({ reason: 'depth' }))
  })

  it('fails loud when a co-worker assigns with no running run (co-workers only act inside a run)', () => {
    expect(() => nextDelegationChain({ assigner: { id: 'mkt', kind: 'coworker' }, assigneeId: 'gtm', assignerRunChains: [] })).toThrow(/no running turn/)
  })
})
