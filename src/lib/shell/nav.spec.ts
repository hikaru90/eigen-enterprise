import { describe, expect, it } from 'vitest'
import { buildShellNav, currentNavId, navItemCurrent, shellVisible } from './nav'

const manifest = (id: string, name: string) => ({ id, name, description: `${name} does work.` })

describe('buildShellNav', () => {
  it("never lists internal modules (the agent's own machinery)", () => {
    const nav = buildShellNav(
      [
        manifest('website', 'Website'),
        { ...manifest('orchestrator', 'Agent internals'), internal: true },
      ],
      new Map([
        ['website', true],
        ['orchestrator', true],
      ]),
    )
    expect(nav.items.map((i) => i.id)).toEqual(['chat', 'overview', 'website', 'agent', 'settings'])
  })

  it('keeps the one fixed order: Chat, Overview, Website, Email, Brand, Agent, Memory, Settings', () => {
    const nav = buildShellNav(
      [
        manifest('memory', 'Memory'),
        manifest('recap', 'Recap'),
        manifest('website', 'Website'),
        manifest('brand', 'Brand'),
        manifest('email', 'Email'),
      ],
      new Map([
        ['website', true],
        ['email', true],
        ['brand', false],
      ]),
    )
    expect(nav.items.map((i) => [i.name, i.href, i.active])).toEqual([
      ['Chat', '/', true],
      ['Overview', '/overview', true],
      ['Website', '/m/website', true],
      ['Email', '/m/email', true],
      ['Brand', '/brand', false],
      ['Agent', '/agent', true],
      ['Memory', '/m/memory', false],
      ['Recap', '/m/recap', false],
      ['Settings', '/settings', true],
    ])
  })

  it('always carries the fixed app entries, even with no modules', () => {
    const nav = buildShellNav([], new Map())
    expect(nav.items.map((i) => i.href)).toEqual(['/', '/overview', '/agent', '/settings'])
  })
})

describe('currentNavId', () => {
  const nav = buildShellNav(
    [manifest('website', 'Website'), manifest('brand', 'Brand'), manifest('memory', 'Memory')],
    new Map(),
  )
  it.each([
    ['/', 'chat'],
    ['/overview', 'overview'],
    ['/m/website/settings', 'website'],
    ['/brand/editor/x', 'brand'],
    ['/agent', 'agent'],
    ['/agent/runs/12', 'agent'],
    ['/agent/activity', 'agent'],
    ['/agent/roadmap', 'agent'],
    ['/runs', null],
    ['/activity', null],
    ['/settings/extensions', 'settings'],
    ['/memory/notes', 'memory'],
    ['/capture', 'memory'],
    ['/settings/api-keys', 'settings'],
    ['/nowhere', null],
  ])('%s -> %s', (path, id) => {
    expect(currentNavId(nav.items, path)).toBe(id)
  })
})

describe('shellVisible', () => {
  const shell = { companyName: null, nav: buildShellNav([], new Map()) }
  it('shows the shell for ordinary signed-in pages', () => {
    expect(shellVisible({ shell })).toBe(true)
  })
  it('hides the shell during the welcome tour and the first-run provider gate', () => {
    expect(shellVisible({ shell, showWelcome: true, needsOnboarding: false })).toBe(false)
    expect(shellVisible({ shell, showWelcome: false, needsOnboarding: true })).toBe(false)
  })
  it('hides the shell when there is no signed-in shell data', () => {
    expect(shellVisible({ shell: null })).toBe(false)
  })
})

describe('navItemCurrent', () => {
  it('matches chat exactly and other entries by prefix', () => {
    expect(navItemCurrent('/', '/')).toBe(true)
    expect(navItemCurrent('/', '/overview')).toBe(false)
    expect(navItemCurrent('/m/website', '/m/website')).toBe(true)
    expect(navItemCurrent('/settings', '/settings/llm')).toBe(true)
    expect(navItemCurrent('/m/web', '/m/website')).toBe(false)
  })
})
