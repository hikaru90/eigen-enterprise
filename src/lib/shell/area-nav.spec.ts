import { describe, expect, it } from 'vitest'
import { ASSISTANT_TABS, BRAND_TABS, DRIVE_TABS, WEBSITE_TABS, currentAreaTab } from './area-nav'

describe('area sub-navigation (one page frame)', () => {
  it('lists the tabs of each area in one order', () => {
    expect(ASSISTANT_TABS.map((t) => t.label)).toEqual(['Conversations', 'Activity'])
    expect(WEBSITE_TABS.map((t) => t.label)).toEqual(['Apps', 'Site', 'Settings'])
    expect(BRAND_TABS.map((t) => t.label)).toEqual(['Style', 'Design system', 'Extract'])
    expect(DRIVE_TABS.map((t) => t.label)).toEqual(['My drive', 'Shared with me', 'Trash'])
  })
  it.each([
    [ASSISTANT_TABS, '/assistant', 'conversations'],
    [ASSISTANT_TABS, '/assistant/48', 'conversations'],
    [ASSISTANT_TABS, '/assistant/activity', 'activity'],
    [ASSISTANT_TABS, '/assistant/activity/', 'activity'],
    [WEBSITE_TABS, '/m/website', 'apps'],
    [WEBSITE_TABS, '/m/website/apps/new', 'apps'],
    [WEBSITE_TABS, '/m/website/apps/blog', 'apps'],
    [WEBSITE_TABS, '/m/website/site', 'site'],
    [WEBSITE_TABS, '/m/website/settings', 'settings'],
    [BRAND_TABS, '/brand', 'style'],
    [BRAND_TABS, '/brand/system', 'system'],
    [BRAND_TABS, '/brand/extract', 'extract'],
    [DRIVE_TABS, '/drive', 'mine'],
    [DRIVE_TABS, '/drive/folder/abc', 'mine'],
    [DRIVE_TABS, '/drive/shared', 'shared'],
    [DRIVE_TABS, '/drive/trash', 'trash'],
  ] as const)('%#: %s → current tab', (tabs, path, id) => {
    expect(currentAreaTab(tabs, path)).toBe(id)
  })
  it('returns null outside the area', () => {
    expect(currentAreaTab(BRAND_TABS, '/brand/editor/x')).toBeNull()
    expect(currentAreaTab(ASSISTANT_TABS, '/agent/runs')).toBeNull()
  })
})
