import { afterEach, describe, expect, it } from 'vitest'
import { openedDurableHarness, resetDurableHarnessSingletonForTests } from './durable-harness'

describe('openedDurableHarness', () => {
  afterEach(() => resetDurableHarnessSingletonForTests())

  it('fails loud instead of opening a harness when boot has not opened one', () => {
    resetDurableHarnessSingletonForTests()
    expect(() => openedDurableHarness()).toThrow(/not open yet/)
  })
})
