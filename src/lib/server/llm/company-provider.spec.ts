import { describe, expect, it } from 'vitest'
import { resolveBillingUserId } from '$lib/server/db/tenant-context'
import { LlmNotConfiguredError } from './errors'
import { onCompanyProvider } from './company-provider'

describe('onCompanyProvider', () => {
  it("resolves the gateway's provider config to the owner's account, not the caller's", async () => {
    const seen = await onCompanyProvider(async () => resolveBillingUserId('member-ana'), async () => 'owner-olga')
    expect(seen).toBe('owner-olga')
  })

  it('leaves calls outside it on their own account', async () => {
    await onCompanyProvider(async () => null, async () => 'owner-olga')
    expect(resolveBillingUserId('member-ana')).toBe('member-ana')
  })

  it('fails loud when the company has no owner yet (no fallback provider)', async () => {
    let ran = false
    const run = onCompanyProvider(async () => {
      ran = true
    }, async () => null)
    await expect(run).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(ran).toBe(false)
  })
})
