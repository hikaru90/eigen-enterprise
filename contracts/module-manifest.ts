import { createHash } from 'node:crypto'
import { CORE_SCHEMA, load, YAMLException } from 'js-yaml'
import { z } from 'zod'

/**
 * `module.yaml` v1 (plan/phase-upgrades-u2.md §2): the manifest every
 * vibe-coded module carries at the root of its folder in the module repo. One
 * strict schema, shared by the kernel, ee and the hub.
 *
 * This file is imported by ee too, so it imports only `zod`, `node:*` and the
 * repo's YAML parser (`js-yaml`) — no `$lib`, no relative imports.
 */

export const MODULE_MANIFEST_FILE = 'module.yaml'
export const MODULE_MANIFEST_FORMAT = 'eigen.module/1'

/** Words a module id can never be, whatever the core ships. */
export const RESERVED_MODULE_IDS = ['kernel', 'core', 'eigen', 'ee', 'os'] as const

/**
 * Every module id the core uses (static manifests, boot-time modules and event
 * owners). A module id may not repeat one, so a name on screen always means one
 * thing. `contracts/module-manifest.spec.ts` keeps this in step with the core.
 */
export const CORE_MODULE_IDS = [
  'agent',
  'assistant',
  'backups',
  'brand',
  'calendar',
  'calls',
  'chat-gateway',
  'company-modules',
  'contacts',
  'contribute',
  'contribute-hub',
  'coworkers',
  'demo',
  'domains',
  'drive',
  'email',
  'kernel',
  'members',
  'memory',
  'messages',
  'module-hub',
  'orchestrator',
  'recap',
  'repos',
  'website',
] as const

/** The runtimes ee's catalog can build and run a module with. */
export const MODULE_RUNTIMES = { node: ['22'] } as const

/** The roles a provided tool may be open to. */
export const MODULE_TOOL_ROLES = ['admin', 'member', 'agent'] as const

export const MODULE_LIMITS = {
  idMin: 2,
  idMax: 24,
  nameMax: 60,
  descriptionMax: 300,
  summaryMax: 200,
  activityMax: 300,
  commands: 16,
  argMax: 4096,
  memoryMb: { min: 64, max: 1024, default: 256 },
  cpuPercent: { min: 10, max: 100, default: 50 },
  timeoutMs: { min: 1000, max: 120_000, default: 30_000 },
  secrets: 10,
} as const

// ─── Derived names ───────────────────────────────────────────────────────────

/** The module's id in the kernel's module registry: `x-<id>`. */
export const kernelModuleId = (id: string): string => `x-${id}`
/** The tool and event namespace: `x_<id with - as _>`. */
export const toolNamespace = (id: string): string => `x_${id.replaceAll('-', '_')}`
/** ee's workload name: `mod-<id>`. */
export const workloadName = (id: string): string => `mod-${id}`
/** A provided tool's registry name: `x_<id_>.<tool>`. */
export const providedToolName = (id: string, tool: string): string => `${toolNamespace(id)}.${tool}`
/** A provided event's stored type: `x_<id_>.<name>`. */
export const providedEventType = (id: string, name: string): string =>
  `${toolNamespace(id)}.${name}`

// ─── Pieces ──────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const CARET_PATTERN = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** A core tool name, as the registry spells it. */
const CORE_TOOL_PATTERN = /^[a-z][a-z0-9_-]*\.[a-z][a-zA-Z0-9_-]*$/
/** A core event type (`contacts.created`). */
const CORE_EVENT_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_]*)+$/
const SLOT_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/
/** A provided tool's or event's local name. */
const LOCAL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,40}$/
/** Env names the module unit sets itself; a secret can never take one. */
const ENV_NAMES_TAKEN = new Set(['PATH', 'HOME', 'NODE_ENV', 'NODE_OPTIONS'])
const RESERVED = new Set<string>([...RESERVED_MODULE_IDS, ...CORE_MODULE_IDS])

export const moduleIdSchema = z
  .string()
  .min(MODULE_LIMITS.idMin)
  .max(MODULE_LIMITS.idMax)
  .regex(ID_PATTERN, 'lowercase letters and digits in words joined by "-", starting with a letter')
  .refine((id) => !RESERVED.has(id), { message: 'is a core module id or a reserved word' })
  .refine((id) => !id.startsWith('x-'), {
    message: 'may not start with "x-" (the kernel adds that prefix itself)',
  })

const semver = z.string().regex(SEMVER_PATTERN, 'MAJOR.MINOR.PATCH')
const caretRange = z
  .string()
  .regex(CARET_PATTERN, 'a caret range like "^1.0.0" (only caret ranges are allowed)')
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim() === s && !/[\r\n]/.test(s), {
      message: 'one line without surrounding spaces',
    })

const argv = z
  .array(
    z
      .string()
      .min(1)
      .max(MODULE_LIMITS.argMax)
      .refine((s) => !s.includes('\0'), { message: 'no NUL bytes' }),
  )
  .min(1)

/** Items of an array that occur more than once. */
function duplicates(items: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const item of items) (seen.has(item) ? dup : seen).add(item)
  return [...dup]
}
const unique = <T extends z.ZodType<string>>(item: T) =>
  z.array(item).superRefine((items, ctx) => {
    for (const d of duplicates(items))
      ctx.addIssue({ code: 'custom', message: `"${d}" is listed twice` })
  })

/** A JSON Schema (2020-12) that zod's `z.fromJSONSchema` accepts. */
const jsonSchema = z.record(z.string(), z.unknown()).superRefine((schema, ctx) => {
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch (err) {
    ctx.addIssue({
      code: 'custom',
      message: `is not a usable JSON Schema: ${(err as Error).message}`,
    })
  }
})

/** A tool's input or output: an object JSON Schema. */
const objectSchema = jsonSchema.refine((s) => s.type === 'object', {
  message: 'must be a JSON Schema with type: object',
})

const PLACEHOLDER = /\{([^{}]*)\}/g
const PLACEHOLDER_BODY = /^(input|output)\.([A-Za-z_][A-Za-z0-9_]*)$/

/**
 * The problems of an activity template: only `{input.x}` / `{output.x}`
 * placeholders, each naming a property its schema declares; no other braces.
 */
export function activityTemplateProblems(
  template: string,
  schemas: { input: Record<string, unknown>; output: Record<string, unknown> },
): string[] {
  const problems: string[] = []
  const stripped = template.replace(PLACEHOLDER, (_whole, body: string) => {
    const m = PLACEHOLDER_BODY.exec(body)
    if (!m) {
      problems.push(`placeholder "{${body}}" is not {input.<name>} or {output.<name>}`)
      return ''
    }
    const side = m[1] as 'input' | 'output'
    const props = schemas[side].properties
    if (!props || typeof props !== 'object' || !Object.hasOwn(props, m[2]!)) {
      problems.push(`placeholder "{${body}}" names no property of the ${side} schema`)
    }
    return ''
  })
  if (/[{}]/.test(stripped)) problems.push('has an unmatched "{" or "}"')
  return problems
}

const providedTool = z
  .strictObject({
    name: z.string().regex(LOCAL_NAME_PATTERN, 'lowercase letters, digits and "_", up to 41'),
    summary: text(MODULE_LIMITS.summaryMax),
    input: objectSchema,
    output: objectSchema,
    auditClass: z.enum(['read', 'mutate', 'external']),
    approvalRisk: z.enum(['internal', 'public', 'external', 'destructive']).optional(),
    approval: z.enum(['none', 'mode', 'always']),
    roles: unique(z.enum(MODULE_TOOL_ROLES))
      .min(1)
      .default([...MODULE_TOOL_ROLES]),
    activity: text(MODULE_LIMITS.activityMax).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(MODULE_LIMITS.timeoutMs.min)
      .max(MODULE_LIMITS.timeoutMs.max)
      .default(MODULE_LIMITS.timeoutMs.default),
  })
  .superRefine((tool, ctx) => {
    if (tool.auditClass !== 'read') {
      if (tool.approvalRisk === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['approvalRisk'],
          message: 'is required unless auditClass is read',
        })
      if (tool.activity === undefined)
        ctx.addIssue({
          code: 'custom',
          path: ['activity'],
          message: 'is required unless auditClass is read',
        })
    }
    if (tool.activity !== undefined) {
      for (const message of activityTemplateProblems(tool.activity, tool))
        ctx.addIssue({ code: 'custom', path: ['activity'], message })
    }
  })

const providedEvent = z.strictObject({
  name: z.string().regex(LOCAL_NAME_PATTERN, 'lowercase letters, digits and "_", up to 41'),
  payload: jsonSchema.optional(),
})

const providedSlot = z.strictObject({
  slot: z.string().regex(SLOT_PATTERN),
  id: z.string().regex(LOCAL_NAME_PATTERN),
  title: text(MODULE_LIMITS.nameMax),
  /** The view, defined by stream D (plan/phase-upgrades-u2.md §9 D). */
  view: z.record(z.string(), z.unknown()),
})

const secretName = z
  .string()
  .regex(ENV_NAME_PATTERN, 'an env name: A–Z, 0–9 and "_", starting with a letter')
  .refine((n) => !n.startsWith('EE_') && !ENV_NAMES_TAKEN.has(n), {
    message: 'is set by ee itself',
  })

const namesUnique = <T extends { name: string }>(
  items: T[],
  ctx: z.RefinementCtx,
  what: string,
) => {
  for (const d of duplicates(items.map((i) => i.name)))
    ctx.addIssue({ code: 'custom', message: `${what} "${d}" is declared twice` })
}

export const moduleManifestSchema = z.strictObject({
  manifest: z.literal(MODULE_MANIFEST_FORMAT),
  id: moduleIdSchema,
  name: text(MODULE_LIMITS.nameMax),
  version: semver,
  description: text(MODULE_LIMITS.descriptionMax),
  license: z.literal('Apache-2.0'),
  requires: z.strictObject({ 'core-api': caretRange }),
  runtime: z.strictObject({ node: z.enum(MODULE_RUNTIMES.node) }),
  build: z.array(argv).max(MODULE_LIMITS.commands),
  test: z.array(argv).min(1).max(MODULE_LIMITS.commands),
  start: argv,
  resources: z
    .strictObject({
      memoryMb: z
        .number()
        .int()
        .min(MODULE_LIMITS.memoryMb.min)
        .max(MODULE_LIMITS.memoryMb.max)
        .default(MODULE_LIMITS.memoryMb.default),
      cpuPercent: z
        .number()
        .int()
        .min(MODULE_LIMITS.cpuPercent.min)
        .max(MODULE_LIMITS.cpuPercent.max)
        .default(MODULE_LIMITS.cpuPercent.default),
    })
    .default({
      memoryMb: MODULE_LIMITS.memoryMb.default,
      cpuPercent: MODULE_LIMITS.cpuPercent.default,
    }),
  uses: z
    .strictObject({
      tools: unique(z.string().regex(CORE_TOOL_PATTERN)).default([]),
      events: unique(z.string().regex(CORE_EVENT_PATTERN)).default([]),
      slots: unique(z.string().regex(SLOT_PATTERN)).default([]),
    })
    .default({ tools: [], events: [], slots: [] }),
  provides: z
    .strictObject({
      tools: z
        .array(providedTool)
        .default([])
        .superRefine((t, ctx) => namesUnique(t, ctx, 'tool')),
      events: z
        .array(providedEvent)
        .default([])
        .superRefine((e, ctx) => namesUnique(e, ctx, 'event')),
      slots: z
        .array(providedSlot)
        .default([])
        .superRefine((s, ctx) => {
          for (const d of duplicates(s.map((x) => x.id)))
            ctx.addIssue({ code: 'custom', message: `slot id "${d}" is declared twice` })
        }),
    })
    .default({ tools: [], events: [], slots: [] }),
  permissions: z
    .strictObject({
      background: z.boolean().default(false),
      secrets: unique(secretName).max(MODULE_LIMITS.secrets).default([]),
      network: z.array(z.string()).max(0, 'must be [] in v1 (no network egress)').default([]),
      capabilities: unique(z.string().regex(CAPABILITY_PATTERN)).default([]),
    })
    .default({ background: false, secrets: [], network: [], capabilities: [] }),
})

/** A parsed, defaults-filled `module.yaml` v1. */
export type ModuleManifestV1 = z.output<typeof moduleManifestSchema>
export type ModuleProvidedTool = ModuleManifestV1['provides']['tools'][number]

// ─── Parsing ─────────────────────────────────────────────────────────────────

export type ManifestProblem = { path: string; line?: number; message: string }

export class ModuleManifestError extends Error {
  readonly problems: ManifestProblem[]
  constructor(problems: ManifestProblem[]) {
    super(
      `${MODULE_MANIFEST_FILE} is not valid: ` +
        problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join('; '),
    )
    this.name = 'ModuleManifestError'
    this.problems = problems
  }
}

export type ManifestParse =
  { ok: true; manifest: ModuleManifestV1 } | { ok: false; problems: ManifestProblem[] }

const issuePath = (path: readonly PropertyKey[]): string =>
  path
    .map((p) => (typeof p === 'number' ? `[${p}]` : String(p)))
    .join('.')
    .replaceAll('.[', '[')

/** Validates an already-parsed manifest value (ee gets it as JSON). */
export function safeParseModuleManifest(value: unknown): ManifestParse {
  const r = moduleManifestSchema.safeParse(value)
  if (r.success) return { ok: true, manifest: r.data }
  return {
    ok: false,
    problems: r.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message })),
  }
}

/** Parses the text of a `module.yaml` (YAML 1.2 core schema), collecting every problem. */
export function safeParseModuleManifestYaml(source: string): ManifestParse {
  let value: unknown
  try {
    value = load(source, { schema: CORE_SCHEMA, filename: MODULE_MANIFEST_FILE })
  } catch (err) {
    if (err instanceof YAMLException) {
      const line = typeof err.mark?.line === 'number' ? err.mark.line + 1 : undefined
      return { ok: false, problems: [{ path: '', ...(line ? { line } : {}), message: err.reason }] }
    }
    throw err
  }
  return safeParseModuleManifest(value)
}

export function parseModuleManifest(value: unknown): ModuleManifestV1 {
  const r = safeParseModuleManifest(value)
  if (!r.ok) throw new ModuleManifestError(r.problems)
  return r.manifest
}

export function parseModuleManifestYaml(source: string): ModuleManifestV1 {
  const r = safeParseModuleManifestYaml(source)
  if (!r.ok) throw new ModuleManifestError(r.problems)
  return r.manifest
}

// ─── Identity ────────────────────────────────────────────────────────────────

function canonical(value: unknown, at: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`canonical JSON: ${at} is not a finite number`)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((v, i) => canonical(v, `${at}[${i}]`)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, `${at}.${k}`)}`).join(',')}}`
  }
  throw new Error(`canonical JSON: ${at} is a ${typeof value}`)
}

/**
 * The manifest's canonical JSON: validated and defaults filled first, then keys
 * sorted recursively, no whitespace. Two spellings of the same manifest give
 * the same bytes.
 */
export function canonicalManifestJson(manifest: unknown): string {
  return canonical(parseModuleManifest(manifest), 'manifest')
}

/** sha256 (hex) of `canonicalManifestJson`. */
export function manifestSha256(manifest: unknown): string {
  return createHash('sha256').update(canonicalManifestJson(manifest), 'utf8').digest('hex')
}

// ─── Compatibility ───────────────────────────────────────────────────────────

const parts = (m: RegExpExecArray): [number, number, number] => [
  Number(m[1]),
  Number(m[2]),
  Number(m[3]),
]

/**
 * Whether `version` satisfies the caret `range` (npm semantics: `^1.2.3` is
 * >=1.2.3 <2.0.0, `^0.2.3` is >=0.2.3 <0.3.0, `^0.0.3` is exactly 0.0.3).
 * Anything but a caret range or a plain version fails loud.
 */
export function satisfiesCoreApi(range: string, version: string): boolean {
  const r = CARET_PATTERN.exec(range)
  if (!r)
    throw new Error(`core-api range "${range}" is not a caret range (only "^MAJOR.MINOR.PATCH")`)
  const v = SEMVER_PATTERN.exec(version)
  if (!v) throw new Error(`core-api version "${version}" is not MAJOR.MINOR.PATCH`)
  const [rM, rm, rp] = parts(r)
  const [vM, vm, vp] = parts(v)
  const atLeast = vM !== rM ? vM > rM : vm !== rm ? vm > rm : vp >= rp
  if (!atLeast) return false
  if (rM > 0) return vM === rM
  if (rm > 0) return vM === 0 && vm === rm
  return vM === 0 && vm === 0 && vp === rp
}

/** What a box (or the hub) offers a module: its lock's names, events, slots and capabilities. */
export type ModuleCatalog = {
  tools: Iterable<string>
  events: Iterable<string>
  slots: Iterable<string>
  capabilities?: Iterable<string>
}

/**
 * Everything the manifest names that `catalog` lacks, as `uses.tools:<name>`,
 * `uses.events:…`, `uses.slots:…`, `provides.slots:…` and
 * `permissions.capabilities:…` (capabilities only when the catalog lists them).
 * Empty means the lockfile tells the truth (R3).
 */
export function manifestCatalogGaps(manifest: ModuleManifestV1, catalog: ModuleCatalog): string[] {
  const tools = new Set(catalog.tools)
  const events = new Set(catalog.events)
  const slots = new Set(catalog.slots)
  const gaps: string[] = []
  for (const t of manifest.uses.tools) if (!tools.has(t)) gaps.push(`uses.tools:${t}`)
  for (const e of manifest.uses.events) if (!events.has(e)) gaps.push(`uses.events:${e}`)
  for (const s of manifest.uses.slots) if (!slots.has(s)) gaps.push(`uses.slots:${s}`)
  for (const s of manifest.provides.slots)
    if (!slots.has(s.slot)) gaps.push(`provides.slots:${s.slot}`)
  if (catalog.capabilities) {
    const caps = new Set(catalog.capabilities)
    for (const c of manifest.permissions.capabilities)
      if (!caps.has(c)) gaps.push(`permissions.capabilities:${c}`)
  }
  return gaps
}
