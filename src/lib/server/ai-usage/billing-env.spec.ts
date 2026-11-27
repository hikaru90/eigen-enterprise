import { describe, expect, it } from 'vitest'
import { AI_BILLING_SECRETS } from '../../../../ee/src/fleet/agent'
import { AI_BILLING_ENV, readAiBilling } from './billing-env'

const full = { EE_AI_BILLING_MARKUP: '1.2', EE_AI_BILLING_USD_TO_EUR: '0.95', EE_AI_BILLING_RATE_DAY: '2026-11-27' }

describe('readAiBilling (EE_AI_BILLING_*, set by ee from desired.aiUsage)', () => {
  it('names the three os secrets ee writes', () => {
    expect(Object.values(AI_BILLING_ENV)).toEqual([...AI_BILLING_SECRETS])
  })

  it('none set → null (self-hosted, or no eigenInference): USD as before', () => {
    expect(readAiBilling({})).toBeNull()
    expect(readAiBilling({ EE_AI_BILLING_MARKUP: ' ' })).toBeNull()
  })

  it('all three → the billing, in EUR', () => {
    expect(readAiBilling(full)).toEqual({ currency: 'EUR', markup: 1.2, usdToEur: 0.95, rateDay: '2026-11-27' })
  })

  it('partial → throws naming the missing ones', () => {
    expect(() => readAiBilling({ ...full, EE_AI_BILLING_USD_TO_EUR: '' })).toThrow(/EE_AI_BILLING_USD_TO_EUR is not set/)
    expect(() => readAiBilling({ EE_AI_BILLING_RATE_DAY: '2026-11-27' })).toThrow(/EE_AI_BILLING_MARKUP, EE_AI_BILLING_USD_TO_EUR are not set/)
  })

  it('a value outside the protocol fails loud, naming the variable', () => {
    expect(() => readAiBilling({ ...full, EE_AI_BILLING_MARKUP: 'abc' })).toThrow(/EE_AI_BILLING_MARKUP/)
    expect(() => readAiBilling({ ...full, EE_AI_BILLING_MARKUP: '0.5' })).toThrow(/EE_AI_BILLING_MARKUP/)
    expect(() => readAiBilling({ ...full, EE_AI_BILLING_USD_TO_EUR: '-1' })).toThrow(/EE_AI_BILLING_USD_TO_EUR/)
    expect(() => readAiBilling({ ...full, EE_AI_BILLING_RATE_DAY: 'today' })).toThrow(/EE_AI_BILLING_RATE_DAY/)
  })
})
