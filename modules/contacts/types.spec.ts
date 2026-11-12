import { describe, expect, it } from 'vitest'
import { channelHref } from './types'

describe('channelHref', () => {
  it('opens mail, a call or the link itself', () => {
    expect(channelHref({ type: 'email', value: 'mara@northwind.example' })).toBe('mailto:mara@northwind.example')
    expect(channelHref({ type: 'phone', value: '+49 (30) 1234-56' })).toBe('tel:+4930123456')
    expect(channelHref({ type: 'linkedin', value: 'https://www.linkedin.com/in/mara' })).toBe('https://www.linkedin.com/in/mara')
    expect(channelHref({ type: 'website', value: 'HTTP://northwind.example' })).toBe('HTTP://northwind.example')
  })

  it('is null for what is not something to open', () => {
    expect(channelHref({ type: 'linkedin', value: 'linkedin.com/in/mara' })).toBeNull()
    expect(channelHref({ type: 'other', value: 'Signal: @mara' })).toBeNull()
    expect(channelHref({ type: 'phone', value: 'ask Ana' })).toBeNull()
    expect(channelHref({ type: 'website', value: 'javascript:alert(1)' })).toBeNull()
  })
})
