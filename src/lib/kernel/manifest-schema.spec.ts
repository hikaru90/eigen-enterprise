import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { manifestJsonSchema, manifestSchema } from './manifest-schema'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from './modules'

const validManifest: ModuleManifest = {
  id: 'memory',
  name: 'Memory',
  version: '0.1.0',
  tools: ['memory.echo', 'memory.wipe'],
  permissions: { roles: ['admin'] },
}

function makeRegistry() {
  return new ModuleRegistry(new InMemoryActivationStore())
}

describe('manifestSchema', () => {
  it('accepts a valid minimal manifest', () => {
    expect(manifestSchema.safeParse(validManifest).success).toBe(true)
    expect(() => makeRegistry().register(validManifest)).not.toThrow()
  })

  it('accepts settingsSchema as pass-through (accept-and-ignore)', () => {
    expect(() => makeRegistry().register({ ...validManifest, settingsSchema: z.object({}) })).not.toThrow()
  })

  it('accepts snake_case tool names (existing module convention)', () => {
    expect(manifestSchema.safeParse({ ...validManifest, tools: ['memory.capture_thought'] }).success).toBe(true)
  })

  it.each([
    ['bad id charset', { ...validManifest, id: 'Bad_Id' }, /invalid module manifest Bad_Id: id:/],
    ['non-semver version', { ...validManifest, version: '0.1' }, /invalid module manifest memory: version:/],
    [
      'tool not namespaced by module',
      { ...validManifest, tools: ['echo'] },
      /invalid module manifest memory: tools\.0:/,
    ],
    [
      'empty roles array',
      { ...validManifest, permissions: { roles: [] } },
      /invalid module manifest memory: permissions\.roles:/,
    ],
  ])('rejects %s from register()', (_label, manifest, pattern) => {
    expect(() => makeRegistry().register(manifest)).toThrow(pattern)
  })

  it('accepts an empty tools array — a module may contribute no kernel tools', () => {
    expect(() => makeRegistry().register({ ...validManifest, tools: [] })).not.toThrow()
  })

  it('accepts declarative agent types and verification policies (phase-1b, optional)', () => {
    const extended: ModuleManifest = {
      ...validManifest,
      agents: [
        {
          loopEngine: 'durable',
          defaults: { personaName: 'Fleet Bot', toolScope: { modules: ['memory'] } },
        },
      ],
      verification: [{ id: 'tests-and-check', description: 'Run tests + checks before shipping.' }],
    }
    expect(manifestSchema.safeParse(extended).success).toBe(true)
    const registry = makeRegistry()
    expect(() => registry.register(extended)).not.toThrow()
    // Fields survive registration (not stripped) so consumers can read them.
    expect(registry.get('memory')?.agents).toEqual(extended.agents)
    expect(registry.get('memory')?.verification).toEqual(extended.verification)
  })

  it('accepts the module ids a module needs to work (requires), and rejects a malformed one', () => {
    expect(() => makeRegistry().register({ ...validManifest, requires: ['messages'] })).not.toThrow()
    expect(() => makeRegistry().register({ ...validManifest, requires: ['Not An Id'] })).toThrow(
      /invalid module manifest memory: requires\.0:/,
    )
  })

  it('rejects a module that requires itself', () => {
    expect(() => makeRegistry().register({ ...validManifest, requires: ['memory'] })).toThrow(
      /module memory cannot require itself/,
    )
  })

  it('accepts manifests without the optional phase-1b fields (omit)', () => {
    const parsed = manifestSchema.safeParse(validManifest)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('agents' in parsed.data).toBe(false)
      expect('verification' in parsed.data).toBe(false)
    }
  })
})

describe('manifestJsonSchema', () => {
  it('publishes a document with the tool-name pattern', () => {
    const doc = manifestJsonSchema() as {
      properties: { tools: { items: { pattern: string } } }
    }
    expect(doc.properties.tools.items.pattern).toBe('^[a-z][a-z0-9_-]*\\.[a-z][a-zA-Z0-9_-]*$')
  })
})
