import { describe, expect, it } from 'vitest'
import { helloManifest } from '$lib/kernel/module-host/testing/hello'
import { wideningOf } from './widening'

describe('wideningOf (D13: what needs an admin’s own click)', () => {
  it('a first deploy always does; the same manifest never does', async () => {
    const m = await helloManifest()
    expect(wideningOf(null, m)).toEqual(['a first deploy'])
    expect(wideningOf(m, m)).toEqual([])
  })

  it('names every widened use, permission and tool role; narrowing is fine', async () => {
    const m = await helloManifest()
    const wider = structuredClone(m)
    wider.uses.tools.push('contacts.get')
    wider.uses.events.push('contacts.created')
    wider.permissions.background = true
    wider.permissions.secrets.push('STRIPE_API_KEY')
    wider.provides.tools.push({ ...wider.provides.tools[0]!, name: 'wave', roles: ['admin'] })
    expect(wideningOf(m, wider)).toEqual([
      'uses.tools: contacts.get',
      'uses.events: contacts.created',
      'permissions.background',
      'permissions.secrets: STRIPE_API_KEY',
      'provides.tools.wave.roles: admin',
    ])
    const narrower = structuredClone(m)
    narrower.uses.tools = []
    narrower.provides.tools[0]!.roles = ['admin']
    expect(wideningOf(m, narrower)).toEqual([])
    const moreRoles = structuredClone(narrower)
    moreRoles.provides.tools[0]!.roles = ['admin', 'member']
    expect(wideningOf(narrower, moreRoles)).toEqual(['provides.tools.greet.roles: member'])
  })
})
