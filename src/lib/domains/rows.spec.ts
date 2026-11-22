import { describe, expect, it } from 'vitest'
import { mailNote } from './rows'

describe('mailNote (Settings › Domains: a bought domain not yet a mail domain)', () => {
  it('says why, in plain words', () => {
    expect(mailNote('configuring', 'managed')).toMatch(/Becoming a mail domain/)
    expect(mailNote('registering', 'managed')).toBeNull()
    expect(mailNote('active', 'own')).toMatch(/your own Amazon SES/)
    expect(mailNote('active', null)).toMatch(/Email isn’t set up/)
    expect(mailNote('failed', 'managed')).toBeNull()
  })
})
