import { describe, expect, it } from 'vitest'
import { AGENT_TABS, BRAND_TABS, WEBSITE_TABS, currentAreaTab } from './area-nav'

describe('area sub-navigation (one page frame)', () => {
  it('lists the tabs of each area in one order', () => {
    expect(AGENT_TABS.map((t) => t.label)).toEqual(['Runs', 'Activity', 'Roadmap'])
    expect(WEBSITE_TABS.map((t) => t.label)).toEqual(['Apps', 'Site', 'Settings'])
    expect(BRAND_TABS.map((t) => t.label)).toEqual(['Style', 'Design system', 'Extract'])
  })
  it.each([
    [AGENT_TABS, '/agent/runs', 'runs'],
    [AGENT_TABS, '/agent/runs/48', 'runs'],
    [AGENT_TABS, '/agent/activity', 'activity'],
    [AGENT_TABS, '/agent/roadmap/', 'roadmap'],
    [WEBSITE_TABS, '/m/website', 'apps'],
    [WEBSITE_TABS, '/m/website/apps/new', 'apps'],
    [WEBSITE_TABS, '/m/website/apps/blog', 'apps'],
    [WEBSITE_TABS, '/m/website/site', 'site'],
    [WEBSITE_TABS, '/m/website/settings', 'settings'],
    [BRAND_TABS, '/brand', 'style'],
    [BRAND_TABS, '/brand/system', 'system'],
    [BRAND_TABS, '/brand/extract', 'extract'],
  ] as const)('%#: %s → current tab', (tabs, path, id) => {
    expect(currentAreaTab(tabs, path)).toBe(id)
  })
  it('returns null outside the area', () => {
    expect(currentAreaTab(BRAND_TABS, '/brand/editor/x')).toBeNull()
    expect(currentAreaTab(AGENT_TABS, '/overview')).toBeNull()
  })
})
