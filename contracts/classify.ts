import type { CoreApiLock, JsonSchema, LockedEvent, LockedTool } from './lock'
import {
  compareSemver,
  isIsoDate,
  isSemver,
  parseSemver,
  removeAfter,
  windowEnded,
  type Deprecation,
} from './deprecations'

/**
 * Structural classification of a core-api diff (plan/phase-upgrades.md R4, §5).
 *
 * Every change is classified by the JSON Schema structure alone — properties,
 * required, types, enums, bounds — never by names or wording:
 * - compatible: a new tool / optional input field / output field / event /
 *   slot, a widened input, a narrowed output, a documentation change;
 * - breaking: a tool, field, event or slot removed; a required input added;
 *   an input narrowed; an output field removed, made optional or retyped;
 *   a role taken away.
 *
 * Input schemas are compared contravariantly (the new core must accept every
 * input the old one did); outputs and event payloads covariantly (the new core
 * may only produce what the old one promised).
 */

export type ContractChange = {
  /** The contract item, in deprecation notation (`tool:contacts.get.output.company`). */
  item: string
  kind: 'breaking' | 'compatible'
  what: string
  /** The item and every ancestor, root first: a deprecation of any of them covers the change. */
  covers: string[]
}

type Direction = 'input' | 'output'

type ItemPath = { root: string; segments: string[] }

function itemId(path: ItemPath): string {
  return [path.root, ...path.segments].join('.')
}

function covers(path: ItemPath): string[] {
  const out = [path.root]
  for (let i = 1; i <= path.segments.length; i++)
    out.push([path.root, ...path.segments.slice(0, i)].join('.'))
  return out
}

function child(path: ItemPath, segment: string): ItemPath {
  return { root: path.root, segments: [...path.segments, segment] }
}

function change(path: ItemPath, kind: ContractChange['kind'], what: string): ContractChange {
  return { item: itemId(path), kind, what, covers: covers(path) }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  return (
    ka.length === kb.length &&
    ka.every(
      (k) => Object.hasOwn(b as object, k) && deepEqual((a as JsonSchema)[k], (b as JsonSchema)[k]),
    )
  )
}

// ─── schema comparison ───────────────────────────────────────────────────────

/** Keywords that only document a schema: a change in them never breaks a caller. */
const DOCUMENTATION = new Set(['description', 'title', 'default', 'examples', '$comment'])
/** Keywords compared structurally below (objects, arrays, unions, value sets). */
const STRUCTURAL = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'anyOf',
  'oneOf',
  'enum',
  'const',
])
/** Lower bounds: a higher value accepts less. */
const LOWER_BOUNDS = [
  'minimum',
  'exclusiveMinimum',
  'minLength',
  'minItems',
  'minProperties',
] as const
/** Upper bounds: a lower value accepts less. */
const UPPER_BOUNDS = [
  'maximum',
  'exclusiveMaximum',
  'maxLength',
  'maxItems',
  'maxProperties',
] as const
const BOUNDS = new Set<string>([...LOWER_BOUNDS, ...UPPER_BOUNDS])

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A union's branches (nested unions flattened); a plain schema is its own single branch. */
function branchesOf(schema: JsonSchema): JsonSchema[] {
  const members = schema.anyOf ?? schema.oneOf
  if (!Array.isArray(members)) return [schema]
  return members.filter(isSchema).flatMap(branchesOf)
}

const ANY = null
type ValueSet<T> = T[] | typeof ANY

function typesOf(schema: JsonSchema): ValueSet<string> {
  if (typeof schema.type === 'string') return [schema.type]
  if (Array.isArray(schema.type))
    return schema.type.filter((t): t is string => typeof t === 'string')
  return ANY
}

function valuesOf(schema: JsonSchema): ValueSet<unknown> {
  if ('const' in schema) return [schema.const]
  if (Array.isArray(schema.enum)) return schema.enum
  return ANY
}

function typeAccepted(wide: ValueSet<string>, type: string): boolean {
  return wide === ANY || wide.includes(type) || (type === 'integer' && wide.includes('number'))
}

/**
 * The facets on which `wide` does not accept every value `narrow` accepts
 * (types, value sets, bounds, exact constraints like pattern/format). Empty
 * when wide ⊇ narrow facet by facet. Objects and arrays recurse separately.
 */
function lostFacets(wide: JsonSchema, narrow: JsonSchema): string[] {
  const lost: string[] = []
  const wideTypes = typesOf(wide)
  const narrowTypes = typesOf(narrow)
  if (
    narrowTypes === ANY ? wideTypes !== ANY : !narrowTypes.every((t) => typeAccepted(wideTypes, t))
  ) {
    lost.push('type')
  }
  const wideValues = valuesOf(wide)
  const narrowValues = valuesOf(narrow)
  if (
    wideValues !== ANY &&
    (narrowValues === ANY || !narrowValues.every((v) => wideValues.some((w) => deepEqual(v, w))))
  ) {
    lost.push('enum')
  }
  for (const key of LOWER_BOUNDS) {
    const w = wide[key]
    const n = narrow[key]
    if (typeof w === 'number' && !(typeof n === 'number' && w <= n)) lost.push(key)
  }
  for (const key of UPPER_BOUNDS) {
    const w = wide[key]
    const n = narrow[key]
    if (typeof w === 'number' && !(typeof n === 'number' && w >= n)) lost.push(key)
  }
  // Every other constraint (pattern, format, propertyNames, allOf, …) is exact:
  // the wide side must have none, or the very same.
  const exact = new Set([...Object.keys(wide), ...Object.keys(narrow)])
  for (const key of exact) {
    if (DOCUMENTATION.has(key) || STRUCTURAL.has(key) || BOUNDS.has(key)) continue
    if (key in wide && !deepEqual(wide[key], narrow[key])) lost.push(key)
  }
  return lost
}

function propertiesOf(schema: JsonSchema): Record<string, JsonSchema> {
  return isSchema(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {}
}

function requiredOf(schema: JsonSchema): Set<string> {
  return new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
}

const isObjectSchema = (schema: JsonSchema) =>
  'properties' in schema || typesOf(schema)?.includes('object') === true

/** Open to fields it does not list (no `additionalProperties: false`). */
const isOpen = (schema: JsonSchema) => schema.additionalProperties !== false

function hasBreaking(changes: ContractChange[]): boolean {
  return changes.some((c) => c.kind === 'breaking')
}

export function compareSchemas(
  old: JsonSchema,
  next: JsonSchema,
  direction: Direction,
  at: ItemPath,
): ContractChange[] {
  if (deepEqual(old, next)) return []
  const oldBranches = branchesOf(old)
  const nextBranches = branchesOf(next)
  if (oldBranches.length > 1 || nextBranches.length > 1)
    return compareUnions(old, next, oldBranches, nextBranches, direction, at)

  const out: ContractChange[] = []
  // Values: the new input must accept what the old accepted; the new output may only produce what the old promised.
  const lost = direction === 'input' ? lostFacets(next, old) : lostFacets(old, next)
  if (lost.length > 0)
    out.push(change(at, 'breaking', `${direction} narrowed or changed: ${lost.join(', ')}`))

  if (isObjectSchema(old) || isObjectSchema(next))
    out.push(...compareObjects(old, next, direction, at))

  if (isSchema(old.items) || isSchema(next.items)) {
    const oldItems = isSchema(old.items) ? old.items : {}
    const nextItems = isSchema(next.items) ? next.items : {}
    out.push(...compareSchemas(oldItems, nextItems, direction, child(at, '[]')))
  }

  if (out.length === 0) out.push(change(at, 'compatible', `${direction} schema changed compatibly`))
  return out
}

function compareObjects(
  old: JsonSchema,
  next: JsonSchema,
  direction: Direction,
  at: ItemPath,
): ContractChange[] {
  const out: ContractChange[] = []
  const oldProps = propertiesOf(old)
  const nextProps = propertiesOf(next)
  const oldRequired = requiredOf(old)
  const nextRequired = requiredOf(next)
  const keys = [...new Set([...Object.keys(oldProps), ...Object.keys(nextProps)])].sort()

  for (const key of keys) {
    const path = child(at, key)
    const inOld = Object.hasOwn(oldProps, key)
    const inNext = Object.hasOwn(nextProps, key)
    if (inOld && !inNext) {
      out.push(change(path, 'breaking', `${direction} field removed`))
      continue
    }
    if (!inOld && inNext) {
      out.push(
        direction === 'input' && nextRequired.has(key)
          ? change(path, 'breaking', 'required input field added')
          : change(path, 'compatible', `${direction} field added`),
      )
      continue
    }
    const nested = compareSchemas(oldProps[key], nextProps[key], direction, path)
    const becameRequired = !oldRequired.has(key) && nextRequired.has(key)
    const becameOptional = oldRequired.has(key) && !nextRequired.has(key)
    if (direction === 'input' && becameRequired)
      out.push(change(path, 'breaking', 'input field now required'))
    else if (direction === 'output' && becameOptional)
      out.push(change(path, 'breaking', 'output field no longer always present'))
    else if ((becameRequired || becameOptional) && nested.length === 0) {
      out.push(
        change(
          path,
          'compatible',
          `${direction} field ${becameRequired ? 'now always present' : 'now optional'}`,
        ),
      )
    }
    out.push(...nested)
  }

  if (direction === 'input' && isOpen(old) && !isOpen(next)) {
    out.push(change(at, 'breaking', 'input object closed to fields it does not list'))
  }
  if (isSchema(old.additionalProperties) && isSchema(next.additionalProperties)) {
    out.push(
      ...compareSchemas(
        old.additionalProperties,
        next.additionalProperties,
        direction,
        child(at, '{}'),
      ),
    )
  }
  return out
}

/**
 * Unions: an input keeps every old shape when each old branch is accepted by
 * some new branch; an output keeps its promise when each new branch is one an
 * old branch allowed. Reported at the union's own path.
 */
function compareUnions(
  old: JsonSchema,
  next: JsonSchema,
  oldBranches: JsonSchema[],
  nextBranches: JsonSchema[],
  direction: Direction,
  at: ItemPath,
): ContractChange[] {
  const fits = (from: JsonSchema, to: JsonSchema) =>
    !hasBreaking(compareSchemas(from, to, direction, at))
  const kept =
    direction === 'input'
      ? oldBranches.every((o) => nextBranches.some((n) => fits(o, n)))
      : nextBranches.every((n) => oldBranches.some((o) => fits(o, n)))
  if (!kept) {
    return [
      change(
        at,
        'breaking',
        direction === 'input'
          ? 'an input shape is no longer accepted'
          : 'the output can take a shape it did not promise',
      ),
    ]
  }
  // compareSchemas returned early for equal schemas: this union changed, compatibly.
  return [change(at, 'compatible', `${direction} union changed compatibly`)]
}

// ─── contract comparison ─────────────────────────────────────────────────────

function byName<T>(items: readonly T[], name: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [name(item), item]))
}

function sortedKeys(...maps: Map<string, unknown>[]): string[] {
  return [...new Set(maps.flatMap((m) => [...m.keys()]))].sort()
}

function compareTools(old: LockedTool, next: LockedTool): ContractChange[] {
  const at: ItemPath = { root: `tool:${old.name}`, segments: [] }
  const out: ContractChange[] = []
  if (old.module !== next.module)
    out.push(change(child(at, 'module'), 'compatible', `module ${old.module} → ${next.module}`))
  if (old.auditClass !== next.auditClass) {
    out.push(
      change(
        child(at, 'auditClass'),
        'compatible',
        `audit class ${old.auditClass} → ${next.auditClass}`,
      ),
    )
  }
  if (!deepEqual(old.approval, next.approval))
    out.push(change(child(at, 'approval'), 'compatible', 'approval flags changed'))
  const lostRoles = old.permission.roles.filter((role) => !next.permission.roles.includes(role))
  if (lostRoles.length > 0) {
    out.push(
      change(
        child(at, 'permission'),
        'breaking',
        `roles no longer allowed: ${lostRoles.join(', ')}`,
      ),
    )
  } else if (!deepEqual(old.permission, next.permission)) {
    out.push(change(child(at, 'permission'), 'compatible', 'roles added'))
  }
  out.push(...compareSchemas(old.input, next.input, 'input', child(at, 'input')))
  out.push(...compareOptionalOutput(old.output, next.output, child(at, 'output')))
  return out
}

function compareOptionalOutput(
  old: JsonSchema | null,
  next: JsonSchema | null,
  at: ItemPath,
): ContractChange[] {
  if (old === null && next === null) return []
  if (old === null) return [change(at, 'compatible', 'schema declared')]
  if (next === null) return [change(at, 'breaking', 'schema dropped')]
  return compareSchemas(old, next, 'output', at)
}

function compareEvents(old: LockedEvent, next: LockedEvent): ContractChange[] {
  const at: ItemPath = { root: `event:${old.type}`, segments: [] }
  const out: ContractChange[] = []
  if (old.module !== next.module)
    out.push(change(child(at, 'module'), 'compatible', `module ${old.module} → ${next.module}`))
  out.push(...compareOptionalOutput(old.payload, next.payload, child(at, 'payload')))
  return out
}

/** Every change from the locked contract to the current one, classified. */
export function diffContracts(locked: CoreApiLock, current: CoreApiLock): ContractChange[] {
  const out: ContractChange[] = []
  if (locked.coreApi !== current.coreApi) {
    out.push(
      change(
        { root: 'coreApi', segments: [] },
        'compatible',
        `coreApi ${locked.coreApi} → ${current.coreApi}`,
      ),
    )
  }

  const oldTools = byName(locked.tools, (t) => t.name)
  const nextTools = byName(current.tools, (t) => t.name)
  for (const name of sortedKeys(oldTools, nextTools)) {
    const o = oldTools.get(name)
    const n = nextTools.get(name)
    const at: ItemPath = { root: `tool:${name}`, segments: [] }
    if (o && !n) out.push(change(at, 'breaking', 'tool removed'))
    else if (!o && n) out.push(change(at, 'compatible', 'tool added'))
    else if (o && n) out.push(...compareTools(o, n))
  }

  const oldEvents = byName(locked.events, (e) => e.type)
  const nextEvents = byName(current.events, (e) => e.type)
  for (const type of sortedKeys(oldEvents, nextEvents)) {
    const o = oldEvents.get(type)
    const n = nextEvents.get(type)
    const at: ItemPath = { root: `event:${type}`, segments: [] }
    if (o && !n) out.push(change(at, 'breaking', 'event removed'))
    else if (!o && n) out.push(change(at, 'compatible', 'event added'))
    else if (o && n) out.push(...compareEvents(o, n))
  }

  const oldSlots = byName(locked.uiSlots, (s) => s.name)
  const nextSlots = byName(current.uiSlots, (s) => s.name)
  for (const name of sortedKeys(oldSlots, nextSlots)) {
    const at: ItemPath = { root: `slot:${name}`, segments: [] }
    if (oldSlots.has(name) && !nextSlots.has(name))
      out.push(change(at, 'breaking', 'UI slot removed'))
    else if (!oldSlots.has(name)) out.push(change(at, 'compatible', 'UI slot added'))
  }
  return out
}

// ─── the gate ────────────────────────────────────────────────────────────────

const ITEM_ROOT = /^(tool|event|slot):\S+$/

/** The violations of one deprecation entry (empty when it is well-formed). */
export function deprecationViolations(d: Deprecation): string[] {
  const out: string[] = []
  const label = `deprecation "${d.item}"`
  if (!ITEM_ROOT.test(d.item))
    out.push(`${label}: item must be tool:…, event:… or slot:… (contracts/deprecations.ts)`)
  if (!isSemver(d.since))
    out.push(`${label}: since "${d.since}" is not a MAJOR.MINOR.PATCH release`)
  if (!isIsoDate(d.sinceDate))
    out.push(`${label}: sinceDate "${d.sinceDate}" is not a YYYY-MM-DD date`)
  if (typeof d.howToMigrate !== 'string' || d.howToMigrate.trim() === '') {
    out.push(
      `${label} has no howToMigrate: write, for the agent that repairs a module, old → new with an example call`,
    )
  }
  return out
}

export type ContractEvaluation = {
  changes: ContractChange[]
  violations: string[]
}

export type EvaluateContractInput = {
  locked: CoreApiLock
  current: CoreApiLock
  deprecations: readonly Deprecation[]
  /** The release being built (package.json version). */
  release: string
  /** Today, YYYY-MM-DD. */
  today: string
}

/**
 * The gate over a classified diff: every breaking change needs a well-formed
 * deprecation covering it whose window has ended, and any breaking change
 * needs a major bump of coreApi. Staleness of the lock file is checked by the
 * caller (a compatible diff is fine, but the lock must be regenerated).
 */
export function evaluateContract(input: EvaluateContractInput): ContractEvaluation {
  const { locked, current, deprecations, release, today } = input
  const changes = diffContracts(locked, current)
  const violations: string[] = []

  const valid: Deprecation[] = []
  for (const d of deprecations) {
    const problems = deprecationViolations(d)
    violations.push(...problems)
    if (problems.length === 0) valid.push(d)
  }

  if (!isSemver(current.coreApi)) {
    violations.push(
      `coreApi "${current.coreApi}" is not a MAJOR.MINOR.PATCH version (contracts/core-api-version.ts)`,
    )
    return { changes, violations }
  }
  if (compareSemver(current.coreApi, locked.coreApi) < 0) {
    violations.push(`coreApi went backwards: ${locked.coreApi} → ${current.coreApi}`)
  }

  const breaking = changes.filter((c) => c.kind === 'breaking')
  const [lockedMajor] = parseSemver(locked.coreApi)
  if (breaking.length > 0 && parseSemver(current.coreApi)[0] <= lockedMajor) {
    violations.push(
      `${breaking.length} breaking change(s) need a major bump of coreApi: set CORE_API_VERSION in contracts/core-api-version.ts to ${lockedMajor + 1}.0.0`,
    )
  }
  for (const b of breaking) {
    const declared = valid.find((d) => b.covers.includes(d.item))
    if (!declared) {
      violations.push(
        `breaking change ${b.item} (${b.what}) is not a declared deprecation: keep the old shape working, declare it in contracts/deprecations.ts with howToMigrate, and remove it only after its window (2 minor releases and 30 days)`,
      )
      continue
    }
    if (!windowEnded(declared, release, today)) {
      const end = removeAfter(declared)
      violations.push(
        `the deprecation window for ${declared.item} has not ended: removable from release ${end.release} and ${end.date} (now release ${release}, ${today}); keep ${b.item} working until then`,
      )
    }
  }
  return { changes, violations }
}
