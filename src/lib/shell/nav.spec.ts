import { describe, expect, it } from 'vitest'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { buildShellNav, currentNavId, navItemCurrent, shellVisible } from './nav'

const manifest = (id: string, name: string) => ({ id, name, description: `${name} does work.` })
const owner = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities
const member = Object.fromEntries(CAPABILITIES.map((c) => [c, false])) as Capabilities

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
      owner,
    )
    expect(nav.items.map((i) => i.id)).toEqual(['website', 'settings'])
  })

  it('keeps the one fixed order: Messages, Calls, Website, Email, Brand, Memory, Drive, Settings', () => {
    const nav = buildShellNav(
      [
        manifest('drive', 'Drive'),
        manifest('memory', 'Memory'),
        manifest('recap', 'Recap'),
        manifest('website', 'Website'),
        manifest('brand', 'Brand'),
        manifest('email', 'Email'),
        manifest('messages', 'Messages'),
        manifest('calls', 'Calls'),
      ],
      new Map([
        ['messages', true],
        ['calls', true],
        ['website', true],
        ['email', true],
        ['brand', false],
        ['drive', true],
      ]),
      owner,
    )
    expect(nav.items.map((i) => [i.name, i.href, i.active])).toEqual([
      ['Messages', '/messages', true],
      ['Calls', '/calls', true],
      ['Website', '/m/website', true],
      ['Email', '/m/email', true],
      ['Brand', '/brand', false],
      ['Memory', '/m/memory', false],
      ['Drive', '/drive', true],
      ['Recap', '/m/recap', false],
      ['Settings', '/settings', true],
    ])
  })

  it('always carries Settings, even with no modules', () => {
    const nav = buildShellNav([], new Map(), member)
    expect(nav.items.map((i) => i.href)).toEqual(['/settings'])
  })

  it('never lists a page the person cannot open: no Website for a member, modules it does not know stay', () => {
    const manifests = [manifest('messages', 'Messages'), manifest('website', 'Website'), manifest('contacts', 'Contacts')]
    const active = new Map([
      ['messages', true],
      ['website', true],
      ['contacts', true],
    ])
    expect(buildShellNav(manifests, active, member).items.map((i) => i.id)).toEqual(['messages', 'contacts', 'settings'])
    expect(buildShellNav(manifests, active, owner).items.map((i) => i.id)).toEqual(['messages', 'website', 'contacts', 'settings'])
  })

  it('has no Assistant, Overview or Agent entry: the assistant is the top bar, the dashboard is the company badge (P-1, P-2)', () => {
    const nav = buildShellNav([manifest('website', 'Website')], new Map([['website', true]]), owner)
    expect(nav.items.map((i) => i.id)).not.toContain('chat')
    expect(nav.items.map((i) => i.id)).not.toContain('overview')
    expect(nav.items.map((i) => i.id)).not.toContain('agent')
    expect(nav.items.map((i) => i.href)).not.toContain('/')
  })
})

describe('currentNavId', () => {
  const nav = buildShellNav(
    [manifest('website', 'Website'), manifest('brand', 'Brand'), manifest('memory', 'Memory')],
    new Map(),
    owner,
  )
  it.each([
    ['/', null],
    ['/overview', null],
    ['/m/website/settings', 'website'],
    ['/brand/editor/x', 'brand'],
    ['/assistant', null],
    ['/assistant/12', null],
    ['/agent/runs/12', null],
    ['/runs', null],
    ['/activity', null],
    ['/settings/extensions', 'settings'],
    ['/m/memory/notes', 'memory'],
    ['/m/memory/capture', 'memory'],
    ['/memory/tasks', null],
    ['/capture', null],
    ['/settings/api-keys', 'settings'],
    ['/nowhere', null],
  ])('%s -> %s', (path, id) => {
    expect(currentNavId(nav.items, path)).toBe(id)
  })
})

describe('shellVisible', () => {
  const shell = {
    companyName: null,
    companyLogo: null,
    capabilities: member,
    nav: buildShellNav([], new Map(), member),
    dictation: { ready: true } as const,
  }
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
