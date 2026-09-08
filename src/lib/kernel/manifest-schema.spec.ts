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
    ['empty tools array', { ...validManifest, tools: [] }, /invalid module manifest memory: tools:/],
    [
      'empty roles array',
      { ...validManifest, permissions: { roles: [] } },
      /invalid module manifest memory: permissions\.roles:/,
    ],
  ])('rejects %s from register()', (_label, manifest, pattern) => {
    expect(() => makeRegistry().register(manifest)).toThrow(pattern)
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
