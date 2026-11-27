import { describe, expect, it } from 'vitest'
import { aiUsageDesiredV1 } from '../../../ee/src/fleet/protocol'
import { aiBillingSchema, billingLine, formatAiEur, invoicedEur } from './billing'

const billing = { currency: 'EUR' as const, markup: 1.2, usdToEur: 0.95, rateDay: '2026-11-27' }

describe('eigenInference billing (hosted: what the company is invoiced)', () => {
  it('€ invoiced = provider USD × markup × USD→EUR, without float residue', () => {
    expect(invoicedEur(1, billing)).toBe(1.14)
    expect(invoicedEur(0.0042, billing)).toBe(0.004788)
    expect(invoicedEur(0, billing)).toBe(0)
    expect(invoicedEur(0.1 + 0.2, { ...billing, markup: 1, usdToEur: 1 })).toBe(0.3)
  })

  it('the bounds are the fleet protocol’s (desired.aiUsage)', () => {
    const wire = { from: '2026-11-01', ...billing }
    expect(aiUsageDesiredV1.safeParse(wire).success).toBe(true)
    expect(aiBillingSchema.safeParse(billing).success).toBe(true)
    for (const bad of [{ markup: 0.9 }, { markup: 11 }, { usdToEur: 0 }, { usdToEur: 11 }, { rateDay: '27.11.2026' }]) {
      expect(aiBillingSchema.safeParse({ ...billing, ...bad }).success, JSON.stringify(bad)).toBe(false)
      expect(aiUsageDesiredV1.safeParse({ ...wire, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('formats EUR like the app formats AI USD: cents, or four places below one cent', () => {
    expect(formatAiEur(0)).toBe('€0.00')
    expect(formatAiEur(0.004788)).toBe('€0.0048')
    expect(formatAiEur(0.00001)).toBe('<€0.0001')
    expect(formatAiEur(1.237)).toBe('€1.24')
    expect(() => formatAiEur(-1)).toThrow()
  })

  it('states how the amount is made, with the rate and its day', () => {
    expect(billingLine(billing)).toBe('Invoiced in EUR: provider cost × 1.2, at 1 USD = 0.95 EUR (rate of 2026-11-27).')
  })
})
