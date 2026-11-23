import { describe, expect, it } from 'vitest'
import { formatAiUsd, formatTokens, replyCostLine, usageMeter, usageSentence, type AiUsageToday } from './usage'

const base: AiUsageToday = {
  role: 'member',
  capUsd: 0.5,
  capApplies: true,
  spentUsd: 0.1,
  remainingUsd: 0.4,
  resetsAt: '2026-11-24T00:00:00.000Z',
}

describe('formatAiUsd / formatTokens / replyCostLine', () => {
  it('shows cents, and four places below one cent', () => {
    expect(formatAiUsd(0)).toBe('$0.00')
    expect(formatAiUsd(0.0042)).toBe('$0.0042')
    expect(formatAiUsd(0.00001)).toBe('<$0.0001')
    expect(formatAiUsd(1.237)).toBe('$1.24')
    expect(() => formatAiUsd(-1)).toThrow()
  })

  it('shortens tokens', () => {
    expect(formatTokens(850)).toBe('850 tokens')
    expect(formatTokens(1234)).toBe('1.2k tokens')
    expect(formatTokens(2000)).toBe('2k tokens')
    expect(formatTokens(3_400_000)).toBe('3.4M tokens')
  })

  it('the reply line is cost and tokens', () => {
    expect(replyCostLine({ costUsd: 0.0042, tokens: 1234, modelCalls: 2 })).toBe('$0.0042 · 1.2k tokens')
    expect(replyCostLine({ costUsd: 0.02, tokens: 0, modelCalls: 1 })).toBe('$0.02')
  })
})

describe('usageMeter', () => {
  it('below 80 % of the cap is the normal zone', () => {
    expect(usageMeter(base)).toMatchObject({ kind: 'capped', zone: 'ok', share: 0.2, spent: '$0.10', cap: '$0.50', left: '$0.40' })
  })

  it('from 80 % it is the red zone, at the cap it is reached', () => {
    expect(usageMeter({ ...base, spentUsd: 0.4, remainingUsd: 0.1 })).toMatchObject({ zone: 'near' })
    const over = usageMeter({ ...base, spentUsd: 0.6, remainingUsd: 0 })
    expect(over).toMatchObject({ zone: 'over', share: 1 })
    expect(usageSentence(over)).toContain('cap is reached')
  })

  it('no cap is said plainly; owner and admins are exempt', () => {
    const none = usageMeter({ ...base, capUsd: null, capApplies: false, remainingUsd: null })
    expect(none).toEqual({ kind: 'no_cap', spent: '$0.10' })
    expect(usageSentence(none)).toContain('no daily cap')
    const exempt = usageMeter({ ...base, role: 'admin', capApplies: false, remainingUsd: null })
    expect(exempt).toEqual({ kind: 'exempt', spent: '$0.10', cap: '$0.50' })
    expect(usageSentence(exempt)).toContain('Owners and admins have no daily cap')
  })
})
