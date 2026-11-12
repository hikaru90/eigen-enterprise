import { describe, expect, it } from 'vitest'
import { CAPABILITIES, canOpen, type Capabilities } from '$lib/access/capabilities'
import { currentSettingsSection, SETTINGS_SECTIONS, settingsSections } from './settings-nav'

const caps = (granted: readonly string[]) =>
  Object.fromEntries(CAPABILITIES.map((c) => [c, granted.includes(c)])) as Capabilities

const owner = caps(CAPABILITIES)
const admin = caps(CAPABILITIES.filter((c) => c !== 'backups.manage'))
const member = caps([])

describe('settings sub-navigation', () => {
  it('holds only company-wide sections (rule 3), in one order', () => {
    expect(settingsSections(admin).map((s) => s.name)).toEqual([
      'Account',
      'Company',
      'Members & invites',
      'AI provider',
      'Passkeys & sessions',
      'API keys',
      'Approval mode',
    ])
    expect(settingsSections(owner).map((s) => s.id).at(-1)).toBe('backups')
  })
  it("Backups is the owner's alone: admins and members never see it", () => {
    expect(settingsSections(admin).some((s) => s.id === 'backups')).toBe(false)
    expect(settingsSections(member).some((s) => s.id === 'backups')).toBe(false)
  })
  it('a member sees only the sections they can open', () => {
    expect(settingsSections(member).map((s) => s.id)).toEqual(['account', 'llm', 'passkeys', 'api-keys'])
  })
  it('every section shown is one the capability set opens (no tab leads to a 403)', () => {
    for (const set of [owner, admin, member]) {
      for (const s of settingsSections(set)) expect(canOpen(set, s.href)).toBe(true)
    }
    expect(SETTINGS_SECTIONS.find((s) => s.id === 'company')?.href).toBe('/settings/company')
  })
  it.each([
    ['/settings', 'account'],
    ['/settings/company', 'company'],
    ['/settings/llm/byok/openrouter', 'llm'],
    ['/settings/api-keys', 'api-keys'],
    ['/settings/backups', 'backups'],
    ['/settings/extensions', null],
  ])('%s -> %s', (path, id) => {
    expect(currentSettingsSection(path)).toBe(id)
  })
})
