import { describe, expect, it } from 'vitest'
import { MANAGED_MAIL_ENV, readManagedMailConfig } from './managed-config'

const full = Object.fromEntries(Object.values(MANAGED_MAIL_ENV).map((n) => [n, `v-${n}`]))

describe('readManagedMailConfig', () => {
  it('none set → null', () => {
    expect(readManagedMailConfig({})).toBeNull()
    expect(readManagedMailConfig({ EE_MAIL_TENANT: '  ' })).toBeNull()
  })

  it('all ten set → the config', () => {
    const c = readManagedMailConfig(full)!
    expect(c.region).toBe('v-EE_MAIL_REGION')
    expect(c.tenant).toBe('v-EE_MAIL_TENANT')
    expect(c.inboundPrefix).toBe('v-EE_MAIL_INBOUND_PREFIX')
    expect(Object.keys(c)).toHaveLength(10)
  })

  it('partial → throws naming the missing ones', () => {
    const partial = { ...full, EE_MAIL_TENANT: undefined, EE_MAIL_INBOUND_BUCKET: '' }
    expect(() => readManagedMailConfig(partial)).toThrow(/EE_MAIL_TENANT, EE_MAIL_INBOUND_BUCKET are not set/)
  })
})
