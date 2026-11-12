import { describe, expect, it } from 'vitest'
import { CAPABILITIES, canOpen, GUARDED_PAGES, pageCapability, type Capabilities } from './capabilities'

const none = Object.fromEntries(CAPABILITIES.map((c) => [c, false])) as Capabilities
const all = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities

describe('pageCapability', () => {
  it.each([
    ['/settings/company', 'company.manage'],
    ['/settings/members', 'members.manage'],
    ['/settings/approvals', 'approvals.manage'],
    ['/settings/backups', 'backups.manage'],
    ['/settings/modules', 'modules.manage'],
    ['/m/website', 'website.manage'],
    ['/m/website/apps/site', 'website.manage'],
    ['/m/website/settings', 'website.manage'],
    ['/brand/extract', 'brand.extract'],
    ['/brand/editor/0b6f5d0e-0000-4000-8000-000000000000', 'brand.extract'],
  ])('%s is guarded by %s', (path, capability) => {
    expect(pageCapability(path)).toBe(capability)
  })

  it.each(['/', '/settings', '/settings/llm', '/settings/api-keys', '/settings/passkeys', '/brand', '/brand/material', '/m/email', '/m/websites', '/messages', '/m/contacts'])(
    '%s needs no capability',
    (path) => {
      expect(pageCapability(path)).toBeNull()
    },
  )

  it('matches whole path segments only', () => {
    expect(pageCapability('/settings/companyx')).toBeNull()
    expect(pageCapability('/m/website-old')).toBeNull()
  })

  it('every capability that guards a page is a known capability', () => {
    for (const page of GUARDED_PAGES) expect(CAPABILITIES).toContain(page.capability)
  })
})

describe('canOpen', () => {
  it('opens every unguarded page for everyone', () => {
    expect(canOpen(none, '/settings')).toBe(true)
    expect(canOpen(none, '/messages')).toBe(true)
  })

  it('opens a guarded page only with its capability', () => {
    expect(canOpen(none, '/m/website')).toBe(false)
    expect(canOpen(all, '/m/website')).toBe(true)
    expect(canOpen({ ...none, 'backups.manage': true }, '/settings/backups')).toBe(true)
    expect(canOpen({ ...none, 'backups.manage': true }, '/settings/members')).toBe(false)
  })
})
