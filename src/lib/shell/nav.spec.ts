import { describe, expect, it } from 'vitest'
import { buildShellNav, navItemCurrent, shellVisible } from './nav'

const manifest = (id: string, name: string) => ({ id, name, description: `${name} does work.` })

describe('buildShellNav', () => {
  it('lists active modules in registry order and inactive ones under Available', () => {
    const nav = buildShellNav(
      [
        manifest('memory', 'Memory'),
        manifest('website', 'Website'),
        manifest('repo', 'Repo'),
        manifest('owlery', 'Email'),
      ],
      new Map([
        ['website', true],
        ['owlery', true],
        ['repo', false],
      ]),
    )
    expect(nav.modules).toEqual([
      { id: 'website', name: 'Website', href: '/m/website', active: true },
      { id: 'owlery', name: 'Email', href: '/m/owlery', active: true },
    ])
    expect(nav.available).toEqual([
      { id: 'memory', name: 'Memory', href: '/m/memory', active: false },
      { id: 'repo', name: 'Repo', href: '/m/repo', active: false },
    ])
  })

  it('always carries the fixed app entries around the modules', () => {
    const nav = buildShellNav([], new Map())
    expect(nav.primary.map((i) => i.href)).toEqual(['/', '/overview'])
    expect(nav.secondary.map((i) => i.href)).toEqual(['/settings'])
    expect(nav.modules).toEqual([])
    expect(nav.available).toEqual([])
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
    expect(navItemCurrent('/settings', '/settings/hosting')).toBe(true)
    expect(navItemCurrent('/m/web', '/m/website')).toBe(false)
  })
})
