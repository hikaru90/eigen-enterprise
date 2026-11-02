import { describe, expect, it } from 'vitest'
import { currentSettingsSection, settingsSections } from './settings-nav'

describe('settings sub-navigation', () => {
  it('holds only company-wide sections (rule 3), in one order', () => {
    expect(settingsSections(true).map((s) => s.name)).toEqual([
      'Account',
      'Members & invites',
      'AI provider',
      'Passkeys & sessions',
      'API keys',
      'Approval mode',
    ])
  })
  it('hides admin-only sections from members', () => {
    expect(settingsSections(false).map((s) => s.id)).toEqual(['account', 'llm', 'passkeys', 'api-keys'])
  })
  it.each([
    ['/settings', 'account'],
    ['/settings/llm/byok/openrouter', 'llm'],
    ['/settings/api-keys', 'api-keys'],
    ['/settings/extensions', null],
  ])('%s -> %s', (path, id) => {
    expect(currentSettingsSection(path)).toBe(id)
  })
})
