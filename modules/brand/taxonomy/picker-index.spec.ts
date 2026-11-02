import { describe, expect, it } from 'vitest'
import { REQUIRED_VISUAL_ROLES } from '../store'
import { pickerNodeSchema, validatePickerNodes, type PickerNode } from './picker-index'

const set = Object.fromEntries(REQUIRED_VISUAL_ROLES.map((r) => [r, r === 'radius' ? '0.5rem' : 'x']))
const node = (id: string, level: PickerNode['level'], parentId: string | null): PickerNode =>
  pickerNodeSchema.parse({
    id,
    level,
    parentId,
    name: id,
    description: id,
    fonts: { heading: 'Inter', body: 'Inter', mono: 'JetBrains Mono' },
    shape: { radius: 'md', density: 'regular', elevation: 'flat', border: 'hairline' },
    tokens: { light: set, dark: set },
    source: { kind: 'authored' },
  })

describe('picker index contract', () => {
  it('rejects a token set missing a required role', () => {
    const { primary: _drop, ...partial } = set
    expect(() =>
      pickerNodeSchema.parse({ ...node('g', 'genre', null), tokens: { light: partial, dark: set } }),
    ).toThrow(/primary/)
  })

  it('accepts a well-formed tree and reports structural errors loud', () => {
    const ok = [node('g', 'genre', null), node('s', 'style', 'g'), node('v', 'variant', 's')]
    expect(validatePickerNodes(ok, { requirePreviews: false })).toEqual([])
    const bad = [node('g', 'genre', null), node('v', 'variant', 'g'), node('v', 'variant', 'g')]
    const errors = validatePickerNodes(bad, { requirePreviews: true })
    expect(errors).toContain('duplicate id "v"')
    expect(errors).toContain('variant "v" must have a style parent, got genre')
    expect(errors).toContain('node "g" has no preview')
  })
})
