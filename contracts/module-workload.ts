import { z } from 'zod'

/**
 * The ee ↔ kernel API for module workloads (plan/phase-upgrades-u2.md §5):
 * the request bodies and answers of every `/v1/modules` verb, the module view
 * and the problem types. ee implements it (`ee/src/modules.ts`), the kernel's
 * ee client calls it. Imported by ee, so only `zod`.
 *
 * The manifest and the receipt travel as plain objects here; each side checks
 * them with `contracts/module-manifest.ts` and `contracts/module-receipt.ts`.
 */

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export const moduleIdParam = z.string().min(2).max(24).regex(MODULE_ID)
/** ee's author field: who asked, as the kernel names them (same bound as ee's other verbs). */
const author = z.string().min(1).max(64)
const sentence = z.string().min(1).max(300)

// ─── Names and places ────────────────────────────────────────────────────────

/** ee's workload name for a module (equals `workloadName` in module-manifest.ts). */
export const moduleWorkload = (id: string): string => `mod-${id}`
/** The module's systemd user. */
export const moduleUnitUser = (id: string): string => `ee-mod-${id}`
/** Where the kernel hands a bundle to ee, relative to `${PATHS.osState}`. */
export const MODULE_BUNDLE_HANDOFF_DIR = 'module-bundles'
/** The hand-off file name: `<id>-<first 12 hex of the bundle sha256>.tar.gz`. */
export const moduleBundleHandoffName = (id: string, bundleSha256: string): string =>
  `${moduleIdParam.parse(id)}-${z.string().regex(HEX64).parse(bundleSha256).slice(0, 12)}.tar.gz`
/** ee's bundle store: `/var/lib/ee/modules/<id>/<bundleSha256>.tar.gz` (root, 0600). */
export const MODULE_BUNDLE_STORE = '/var/lib/ee/modules'
/** Releases ee keeps per module. */
export const MODULE_RELEASES_KEPT = 3
/** The kernel's socket directory for a module, under `$EE_STATE_DIR` (ee bind-mounts it to /run/ee-module). */
export const moduleSocketDir = (stateDir: string, id: string): string =>
  `${stateDir}/modules/${moduleIdParam.parse(id)}/run`
/** The env a module unit gets, exactly (plus EE_MODULE_TOKEN and declared secrets in its EnvironmentFile). */
export const MODULE_UNIT_ENV = [
  'EE_MODULE_ID',
  'EE_MODULE_COMMIT',
  'EE_MODULE_SOCKET',
  'NODE_ENV',
  'PATH',
] as const
export const MODULE_TOKEN_ENV = 'EE_MODULE_TOKEN'
/** The test unit's time limit. */
export const MODULE_TEST_TIMEOUT_MS = 10 * 60_000

// ─── The view ────────────────────────────────────────────────────────────────

export const MODULE_RUN_STATES = [
  'building',
  'testing',
  'starting',
  'running',
  'failed',
  'stopped',
] as const
export const moduleRunStateSchema = z.enum(MODULE_RUN_STATES)
export type ModuleRunState = z.output<typeof moduleRunStateSchema>

export const MODULE_STOP_REASONS = ['person', 'failed'] as const
export const moduleStopReasonSchema = z.enum(MODULE_STOP_REASONS)

export const moduleViewSchema = z.strictObject({
  id: moduleIdParam,
  workload: z.string().regex(/^mod-[a-z][a-z0-9-]*$/),
  version: z.string().regex(SEMVER),
  commit: z.string().regex(HEX40),
  bundleSha256: z.string().regex(HEX64),
  desired: z.enum(['running', 'stopped']),
  stopReason: moduleStopReasonSchema.nullable(),
  state: moduleRunStateSchema,
  /** Why it is failed or stopped, as a sentence a person reads; null otherwise. */
  error: sentence.nullable(),
  restarts: z.number().int().nonnegative(),
  since: z.iso.datetime(),
  /** The last releases, newest first. */
  releases: z
    .array(
      z.strictObject({ commit: z.string().regex(HEX40), bundleSha256: z.string().regex(HEX64) }),
    )
    .max(MODULE_RELEASES_KEPT),
})
export type ModuleView = z.output<typeof moduleViewSchema>

// ─── Verbs ───────────────────────────────────────────────────────────────────

/** POST /v1/modules — deploy (or, with dryRun, only build and test). */
export const deployModuleRequestSchema = z
  .strictObject({
    id: moduleIdParam,
    version: z.string().regex(SEMVER),
    commit: z.string().regex(HEX40),
    manifest: z.record(z.string(), z.unknown()),
    receipt: z.record(z.string(), z.unknown()),
    /** The hand-off file name in `${PATHS.osState}/module-bundles/`. */
    tarball: z.string().regex(/^[a-z][a-z0-9-]*-[0-9a-f]{12}\.tar\.gz$/),
    sha256: z.string().regex(HEX64),
    token: z.string().regex(HEX64),
    author,
    dryRun: z.boolean().optional(),
  })
  .superRefine((r, ctx) => {
    if (r.tarball !== `${r.id}-${r.sha256.slice(0, 12)}.tar.gz`)
      ctx.addIssue({
        code: 'custom',
        path: ['tarball'],
        message: 'must be <id>-<sha256[0:12]>.tar.gz',
      })
  })
export type DeployModuleRequest = z.output<typeof deployModuleRequestSchema>

/** 202 for a deploy. */
export const moduleAnswerSchema = z.strictObject({ module: moduleViewSchema })
export type ModuleAnswer = z.output<typeof moduleAnswerSchema>
/** 200 for a dry run. */
export const dryRunAnswerSchema = z.strictObject({
  passed: z.boolean(),
  log: z.string().max(1024 * 1024),
})
export type DryRunAnswer = z.output<typeof dryRunAnswerSchema>

/** GET /v1/modules */
export const moduleListAnswerSchema = z.strictObject({ modules: z.array(moduleViewSchema) })
export type ModuleListAnswer = z.output<typeof moduleListAnswerSchema>

/** POST /v1/modules/:id/stop */
export const stopModuleRequestSchema = z.strictObject({
  author,
  reason: moduleStopReasonSchema,
  sentence,
})
export type StopModuleRequest = z.output<typeof stopModuleRequestSchema>

/** POST /v1/modules/:id/start */
export const startModuleRequestSchema = z.strictObject({ author })
export type StartModuleRequest = z.output<typeof startModuleRequestSchema>

/** DELETE /v1/modules/:id — the module's data stays in the data repo. */
export const removeModuleRequestSchema = z.strictObject({ author })
export type RemoveModuleRequest = z.output<typeof removeModuleRequestSchema>

/** GET /v1/modules/:id/logs?lines=200 */
export const MODULE_LOG_LINES = { default: 200, max: 2000 } as const
export const moduleLogsQuerySchema = z.strictObject({
  lines: z.coerce.number().int().min(1).max(MODULE_LOG_LINES.max).default(MODULE_LOG_LINES.default),
})
export const moduleLogsAnswerSchema = z.strictObject({ lines: z.array(z.string()) })
export type ModuleLogsAnswer = z.output<typeof moduleLogsAnswerSchema>

// ─── Problems ────────────────────────────────────────────────────────────────

/** The problem types the module verbs answer with (RFC 9457 `type`). */
export const MODULE_PROBLEM_TYPES = {
  /** 422: the receipt (or what it pins) does not check out; `detail` names the first failure. */
  receiptInvalid: 'urn:ee:receipt_invalid',
  /** 422: the box's catalog lacks something the manifest needs; `missing` lists it. */
  catalogGap: 'urn:ee:catalog_gap',
  /** 409: the module is building, testing or starting already. */
  moduleBusy: 'urn:ee:module_busy',
  /** 404 */
  moduleNotFound: 'urn:ee:module_not_found',
  /** 403: POST /v1/secrets for `mod-<id>` with a name not in the receipted permissions.secrets. */
  secretUndeclared: 'urn:ee:secret_undeclared',
} as const
export type ModuleProblemType = (typeof MODULE_PROBLEM_TYPES)[keyof typeof MODULE_PROBLEM_TYPES]

export const moduleProblemSchema = z.object({
  type: z.enum(Object.values(MODULE_PROBLEM_TYPES) as [ModuleProblemType, ...ModuleProblemType[]]),
  title: z.string().min(1),
  detail: z.string().min(1),
  missing: z.array(z.string()).optional(),
})
export type ModuleProblem = z.output<typeof moduleProblemSchema>
