import { describe, expect, it } from 'vitest'
import { addTraceTokens, currentTraceTokens, getCurrentTraceGroupId, runWithTrace } from './trace-context'

describe('trace-context', () => {
  it('stores and reads the current trace group id within runWithTrace', async () => {
    await runWithTrace('group-123', async () => {
      expect(getCurrentTraceGroupId()).toBe('group-123')
    })
    expect(getCurrentTraceGroupId()).toBeUndefined()
  })

  it('counts the tokens model calls report into their own trace only', async () => {
    const counted = await runWithTrace('turn-a', async () => {
      addTraceTokens(120)
      await Promise.resolve()
      addTraceTokens(30)
      const inner = await runWithTrace('turn-b', async () => {
        addTraceTokens(5)
        return currentTraceTokens()
      })
      expect(inner).toBe(5)
      return currentTraceTokens()
    })
    expect(counted).toBe(150)
  })

  it('outside a trace a count is dropped, a read fails loud, a bad count throws', () => {
    expect(() => addTraceTokens(10)).not.toThrow()
    expect(() => currentTraceTokens()).toThrow(/outside runWithTrace/)
    expect(() => addTraceTokens(-1)).toThrow()
  })
})
