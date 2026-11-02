import { describe, expect, it } from 'vitest'
import { docTitle } from './title'

describe('docTitle', () => {
  it('follows "<Page> · <Section> · eigenEnterprise"', () => {
    expect(docTitle('API keys', 'Settings')).toBe('API keys · Settings · eigenEnterprise')
  })
  it("drops empty parts: a section's own page", () => {
    expect(docTitle('Settings')).toBe('Settings · eigenEnterprise')
    expect(docTitle(null, ' ', 'Chat')).toBe('Chat · eigenEnterprise')
  })
  it('is just the product name with no parts', () => {
    expect(docTitle()).toBe('eigenEnterprise')
  })
})
