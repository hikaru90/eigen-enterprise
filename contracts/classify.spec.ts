import type { Deprecation } from './deprecations'
import type { CoreApiLock, JsonSchema, LockedTool } from './lock'
import { describe, expect, it } from 'vitest'
import { diffContracts, evaluateContract, type ContractChange } from './classify'

const obj = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  extra: JsonSchema = {},
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
  ...extra,
})

function tool(name: string, overrides: Partial<LockedTool> = {}): LockedTool {
  return {
    name,
    module: name.split('.')[0],
    auditClass: 'read',
    permission: { roles: ['admin', 'member'] },
    approval: { risk: null, always: false, gated: false },
    input: obj({ id: { type: 'string' } }, ['id']),
    output: obj({ id: { type: 'string' }, company: { type: 'string' } }, ['id', 'company']),
    ...overrides,
  }
}

function contract(tools: LockedTool[], extra: Partial<CoreApiLock> = {}): CoreApiLock {
  return {
    coreApi: '1.0.0',
    tools,
    events: [{ type: 'contacts.created', module: 'contacts', payload: null }],
    uiSlots: [],
    ...extra,
  }
}

const breaking = (changes: ContractChange[]) =>
  changes.filter((c) => c.kind === 'breaking').map((c) => c.item)
const compatible = (changes: ContractChange[]) =>
  changes.filter((c) => c.kind === 'compatible').map((c) => c.item)

describe('diffContracts — tools', () => {
  it('an identical contract has no changes', () => {
    expect(
      diffContracts(contract([tool('contacts.get')]), contract([tool('contacts.get')])),
    ).toEqual([])
  })

  it('a new tool is compatible; a removed (or renamed) tool is breaking', () => {
    const changes = diffContracts(
      contract([tool('contacts.get')]),
      contract([tool('contacts.fetch')]),
    )
    expect(breaking(changes)).toEqual(['tool:contacts.get'])
    expect(compatible(changes)).toEqual(['tool:contacts.fetch'])
  })

  it('a new optional input field is compatible; a new required input field is breaking', () => {
    const optional = tool('contacts.get', {
      input: obj({ id: { type: 'string' }, full: { type: 'boolean' } }, ['id']),
    })
    expect(breaking(diffContracts(contract([tool('contacts.get')]), contract([optional])))).toEqual(
      [],
    )
    expect(
      compatible(diffContracts(contract([tool('contacts.get')]), contract([optional]))),
    ).toEqual(['tool:contacts.get.input.full'])
    const required = tool('contacts.get', {
      input: obj({ id: { type: 'string' }, full: { type: 'boolean' } }, ['id', 'full']),
    })
    expect(breaking(diffContracts(contract([tool('contacts.get')]), contract([required])))).toEqual(
      ['tool:contacts.get.input.full'],
    )
  })

  it('an optional input field becoming required is breaking; required becoming optional is compatible', () => {
    const a = tool('x.t', { input: obj({ id: { type: 'string' }, n: { type: 'number' } }, ['id']) })
    const b = tool('x.t', {
      input: obj({ id: { type: 'string' }, n: { type: 'number' } }, ['id', 'n']),
    })
    expect(breaking(diffContracts(contract([a]), contract([b])))).toEqual(['tool:x.t.input.n'])
    expect(breaking(diffContracts(contract([b]), contract([a])))).toEqual([])
  })

  it('a removed input field is breaking', () => {
    const before = tool('x.t', {
      input: obj({ id: { type: 'string' }, q: { type: 'string' } }, ['id']),
    })
    const after = tool('x.t', { input: obj({ id: { type: 'string' } }, ['id']) })
    expect(breaking(diffContracts(contract([before]), contract([after])))).toEqual([
      'tool:x.t.input.q',
    ])
  })

  it('an input type narrowed is breaking; widened is compatible', () => {
    const wide = tool('x.t', { input: obj({ id: { type: ['string', 'null'] } }, ['id']) })
    const narrow = tool('x.t', { input: obj({ id: { type: 'string' } }, ['id']) })
    expect(breaking(diffContracts(contract([wide]), contract([narrow])))).toEqual([
      'tool:x.t.input.id',
    ])
    expect(breaking(diffContracts(contract([narrow]), contract([wide])))).toEqual([])
    expect(compatible(diffContracts(contract([narrow]), contract([wide])))).toEqual([
      'tool:x.t.input.id',
    ])
  })

  it('number → integer narrows an input; integer → number widens it', () => {
    const num = tool('x.t', { input: obj({ n: { type: 'number' } }) })
    const int = tool('x.t', { input: obj({ n: { type: 'integer' } }) })
    expect(breaking(diffContracts(contract([num]), contract([int])))).toEqual(['tool:x.t.input.n'])
    expect(breaking(diffContracts(contract([int]), contract([num])))).toEqual([])
  })

  it('an input enum losing a value or a tighter bound is breaking; gaining one is compatible', () => {
    const ab = tool('x.t', { input: obj({ k: { type: 'string', enum: ['a', 'b'] } }) })
    const a = tool('x.t', { input: obj({ k: { type: 'string', enum: ['a'] } }) })
    expect(breaking(diffContracts(contract([ab]), contract([a])))).toEqual(['tool:x.t.input.k'])
    expect(breaking(diffContracts(contract([a]), contract([ab])))).toEqual([])

    const loose = tool('x.t', { input: obj({ s: { type: 'string', maxLength: 200 } }) })
    const tight = tool('x.t', {
      input: obj({ s: { type: 'string', maxLength: 100, pattern: '^a' } }),
    })
    expect(breaking(diffContracts(contract([loose]), contract([tight])))).toEqual([
      'tool:x.t.input.s',
    ])
    expect(breaking(diffContracts(contract([tight]), contract([loose])))).toEqual([])
  })

  it('closing an open input object is breaking', () => {
    const open = tool('x.t', { input: { type: 'object', properties: {}, required: [] } })
    const closed = tool('x.t', { input: obj({}) })
    expect(breaking(diffContracts(contract([open]), contract([closed])))).toEqual([
      'tool:x.t.input',
    ])
  })

  it('nested fields carry their path; array items are "[]"', () => {
    const before = tool('x.t', {
      input: obj({
        rows: { type: 'array', items: obj({ a: { type: 'string' }, b: { type: 'string' } }) },
      }),
    })
    const after = tool('x.t', {
      input: obj({ rows: { type: 'array', items: obj({ a: { type: 'string' } }) } }),
    })
    expect(breaking(diffContracts(contract([before]), contract([after])))).toEqual([
      'tool:x.t.input.rows.[].b',
    ])
  })

  it('a new output field is compatible; a removed or type-changed output field is breaking', () => {
    const added = tool('contacts.get', {
      output: obj(
        { id: { type: 'string' }, company: { type: 'string' }, phone: { type: 'string' } },
        ['id', 'company'],
      ),
    })
    const base = contract([tool('contacts.get')])
    expect(breaking(diffContracts(base, contract([added])))).toEqual([])
    expect(compatible(diffContracts(base, contract([added])))).toEqual([
      'tool:contacts.get.output.phone',
    ])

    const removed = tool('contacts.get', { output: obj({ id: { type: 'string' } }, ['id']) })
    expect(breaking(diffContracts(base, contract([removed])))).toEqual([
      'tool:contacts.get.output.company',
    ])

    const retyped = tool('contacts.get', {
      output: obj({ id: { type: 'string' }, company: { type: 'number' } }, ['id', 'company']),
    })
    expect(breaking(diffContracts(base, contract([retyped])))).toEqual([
      'tool:contacts.get.output.company',
    ])
  })

  it('an output field becoming optional or nullable is breaking; nullable → non-null is compatible', () => {
    const base = contract([tool('contacts.get')])
    const optional = tool('contacts.get', {
      output: obj({ id: { type: 'string' }, company: { type: 'string' } }, ['id']),
    })
    expect(breaking(diffContracts(base, contract([optional])))).toEqual([
      'tool:contacts.get.output.company',
    ])

    const nullable = tool('contacts.get', {
      output: obj(
        { id: { type: 'string' }, company: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        ['id', 'company'],
      ),
    })
    expect(breaking(diffContracts(base, contract([nullable])))).toEqual([
      'tool:contacts.get.output.company',
    ])
    expect(breaking(diffContracts(contract([nullable]), base))).toEqual([])
  })

  it('an output schema dropped is breaking; one added where there was none is compatible', () => {
    const none = tool('x.t', { output: null })
    expect(breaking(diffContracts(contract([tool('x.t')]), contract([none])))).toEqual([
      'tool:x.t.output',
    ])
    expect(breaking(diffContracts(contract([none]), contract([tool('x.t')])))).toEqual([])
  })

  it('a union input keeps working when every old branch is still accepted', () => {
    const two = tool('x.t', {
      input: {
        anyOf: [obj({ a: { type: 'string' } }, ['a']), obj({ b: { type: 'string' } }, ['b'])],
      },
    })
    const three = tool('x.t', {
      input: {
        anyOf: [
          obj({ a: { type: 'string' } }, ['a']),
          obj({ b: { type: 'string' } }, ['b']),
          obj({ c: { type: 'string' } }, ['c']),
        ],
      },
    })
    expect(breaking(diffContracts(contract([two]), contract([three])))).toEqual([])
    expect(breaking(diffContracts(contract([three]), contract([two])))).toEqual(['tool:x.t.input'])
  })

  it('descriptions and defaults are documentation: a change is compatible, not breaking', () => {
    const a = tool('x.t', {
      input: obj({ id: { type: 'string', description: 'old words' } }, ['id']),
    })
    const b = tool('x.t', {
      input: obj({ id: { type: 'string', description: 'new words', default: 'x' } }, ['id']),
    })
    expect(breaking(diffContracts(contract([a]), contract([b])))).toEqual([])
    expect(compatible(diffContracts(contract([a]), contract([b])))).toEqual(['tool:x.t.input.id'])
  })

  it('a role taken away is breaking; a role added, an audit or approval change is compatible', () => {
    const base = contract([tool('x.t')])
    expect(
      breaking(diffContracts(base, contract([tool('x.t', { permission: { roles: ['admin'] } })]))),
    ).toEqual(['tool:x.t.permission'])
    const widened = tool('x.t', { permission: { roles: ['admin', 'agent', 'member'] } })
    expect(breaking(diffContracts(base, contract([widened])))).toEqual([])
    const approval = tool('x.t', {
      auditClass: 'mutate',
      approval: { risk: 'internal', always: false, gated: true },
    })
    const changes = diffContracts(base, contract([approval]))
    expect(breaking(changes)).toEqual([])
    expect(compatible(changes)).toEqual(['tool:x.t.auditClass', 'tool:x.t.approval'])
  })
})

describe('diffContracts — events, slots, version', () => {
  it('a new event is compatible; a removed event is breaking', () => {
    const before = contract([], { events: [{ type: 'a.done', module: 'a', payload: null }] })
    const after = contract([], { events: [{ type: 'b.done', module: 'b', payload: null }] })
    const changes = diffContracts(before, after)
    expect(breaking(changes)).toEqual(['event:a.done'])
    expect(compatible(changes)).toEqual(['event:b.done'])
  })

  it('an event payload is compared like an output', () => {
    const before = contract([], {
      events: [{ type: 'a.done', module: 'a', payload: obj({ id: { type: 'string' } }, ['id']) }],
    })
    const after = contract([], { events: [{ type: 'a.done', module: 'a', payload: obj({}) }] })
    expect(breaking(diffContracts(before, after))).toEqual(['event:a.done.payload.id'])
  })

  it('a removed UI slot is breaking; a new one is compatible', () => {
    const before = contract([], { uiSlots: [{ name: 'contacts.sidebar' }] })
    const after = contract([], { uiSlots: [{ name: 'contacts.header' }] })
    const changes = diffContracts(before, after)
    expect(breaking(changes)).toEqual(['slot:contacts.sidebar'])
    expect(compatible(changes)).toEqual(['slot:contacts.header'])
  })

  it('a version bump alone is a compatible change of the contract', () => {
    expect(diffContracts(contract([]), contract([], { coreApi: '1.1.0' }))).toEqual([
      { item: 'coreApi', kind: 'compatible', what: 'coreApi 1.0.0 → 1.1.0', covers: ['coreApi'] },
    ])
  })
})

const migrate =
  'Read `company` from contacts.get output `organization.name` instead. Old: ee tool run contacts.get --input \'{"id":"c1"}\' → .company. New: same call → .organization.name.'

function deprecation(overrides: Partial<Deprecation> = {}): Deprecation {
  return {
    item: 'tool:contacts.get.output.company',
    since: '0.5.40',
    sinceDate: '2026-11-01',
    replacement: 'tool:contacts.get.output.organization.name',
    howToMigrate: migrate,
    ...overrides,
  }
}

describe('evaluateContract — the gate', () => {
  const locked = contract([tool('contacts.get')])
  const removed = (coreApi: string) =>
    contract([tool('contacts.get', { output: obj({ id: { type: 'string' } }, ['id']) })], {
      coreApi,
    })

  it("compatible changes pass the classification (staleness is the lock writer's job)", () => {
    const current = contract([tool('contacts.get'), tool('contacts.list')])
    expect(
      evaluateContract({
        locked,
        current,
        deprecations: [],
        release: '0.5.40',
        today: '2026-11-24',
      }).violations,
    ).toEqual([])
  })

  it('a breaking change without a deprecation fails, naming the item and the fix', () => {
    const { violations } = evaluateContract({
      locked,
      current: removed('2.0.0'),
      deprecations: [],
      release: '0.8.0',
      today: '2027-01-01',
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('tool:contacts.get.output.company')
    expect(violations[0]).toContain('contracts/deprecations.ts')
  })

  it('a breaking change with an ended deprecation and a major bump passes', () => {
    const result = evaluateContract({
      locked,
      current: removed('2.0.0'),
      deprecations: [deprecation()],
      release: '0.7.0',
      today: '2026-12-01',
    })
    expect(result.violations).toEqual([])
  })

  it('a deprecation of an ancestor covers the removal (deprecating the tool covers its fields)', () => {
    const result = evaluateContract({
      locked,
      current: contract([], { coreApi: '2.0.0' }),
      deprecations: [
        deprecation({ item: 'tool:contacts.get', replacement: 'tool:contacts.fetch' }),
      ],
      release: '0.7.0',
      today: '2026-12-01',
    })
    expect(result.violations).toEqual([])
  })

  it('removing before the window ends fails: 2 minor releases AND 30 days, whichever is later', () => {
    const tooFewReleases = evaluateContract({
      locked,
      current: removed('2.0.0'),
      deprecations: [deprecation()],
      release: '0.6.9',
      today: '2027-06-01',
    })
    expect(tooFewReleases.violations.join('\n')).toMatch(
      /window.*has not ended.*0\.7\.0.*2026-12-01/,
    )
    const tooFewDays = evaluateContract({
      locked,
      current: removed('2.0.0'),
      deprecations: [deprecation()],
      release: '0.9.0',
      today: '2026-11-30',
    })
    expect(tooFewDays.violations.join('\n')).toMatch(/window.*has not ended/)
  })

  it('any removal requires a major bump of coreApi', () => {
    const { violations } = evaluateContract({
      locked,
      current: removed('1.1.0'),
      deprecations: [deprecation()],
      release: '0.7.0',
      today: '2026-12-01',
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/major bump.*2\.0\.0/)
  })

  it('a deprecation without howToMigrate fails, even with nothing removed', () => {
    const { violations } = evaluateContract({
      locked,
      current: locked,
      deprecations: [deprecation({ howToMigrate: '   ' })],
      release: '0.5.40',
      today: '2026-11-24',
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/howToMigrate/)
  })

  it('a deprecation with a malformed item, release or date fails', () => {
    const { violations } = evaluateContract({
      locked,
      current: locked,
      deprecations: [deprecation({ item: 'contacts.get', since: 'v1', sinceDate: '1 Nov' })],
      release: '0.5.40',
      today: '2026-11-24',
    })
    expect(violations).toHaveLength(3)
  })

  it('the coreApi version never goes backwards', () => {
    const { violations } = evaluateContract({
      locked: contract([], { coreApi: '2.0.0' }),
      current: contract([], { coreApi: '1.9.0' }),
      deprecations: [],
      release: '0.5.40',
      today: '2026-11-24',
    })
    expect(violations.join('\n')).toMatch(/backwards/)
  })
})
