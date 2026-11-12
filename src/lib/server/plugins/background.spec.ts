import { describe, expect, it } from 'vitest'
import { pluginOn, type BackgroundDeps } from './background'

function deps(active: Record<string, boolean>) {
  const logs: string[] = []
  const d: BackgroundDeps = {
    isActive: async (id) => active[id] === true,
    pluginName: async (id) => ({ email: 'Email', memory: 'Memory' })[id] ?? id,
    log: (line) => logs.push(line),
  }
  return { d, logs }
}

describe('pluginOn (background work of a plugin)', () => {
  it('lets the work run while the plugin is on, silently', async () => {
    const { d, logs } = deps({ email: true })
    expect(await pluginOn('email', 'email background work', d)).toBe(true)
    expect(logs).toEqual([])
  })

  it('skips the work while the plugin is off, with one log line per skipped run', async () => {
    const { d, logs } = deps({ email: false })
    expect(await pluginOn('email', 'email background work', d)).toBe(false)
    expect(logs).toEqual(['[plugins] Email is switched off: skipped email background work'])
    expect(await pluginOn('email', 'email background work', d)).toBe(false)
    expect(logs).toHaveLength(2)
  })

  it('treats a plugin without an activation record as off (fail closed)', async () => {
    expect(await pluginOn('memory', 'overnight consolidation', deps({}).d)).toBe(false)
  })
})
