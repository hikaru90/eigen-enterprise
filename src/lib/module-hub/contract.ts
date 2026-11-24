import { z } from 'zod'
import { BUNDLE_LIMITS } from '../../../contracts/module-bundle'
import { moduleIdSchema } from '../../../contracts/module-manifest'
import { moduleReceiptSchema } from '../../../contracts/module-receipt'
import { moduleRunStateSchema } from '../../../contracts/module-workload'

/**
 * The wire contract between a box and the module hub (plan/phase-upgrades-u2.md
 * §6.2), in $lib so the hub module, the box's publish client and the mock hub
 * share it without importing each other. Requests are signed exactly like contributions
 * (modules/contribute/share/contract.ts) and an install registers through the
 * same /api/hub/register. Both ends parse with these strict schemas. Pure: no
 * server imports, so the box client, the hub and the mock hub share it.
 */

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

export const bundleShaSchema = z.string().regex(HEX64, '64 lowercase hex')

export const MODULE_HUB_PATHS = {
  /** The contribute hub's register, reused (one install identity for both hubs). */
  register: '/api/hub/register',
  publish: '/api/hub/modules/publish',
  bundle: (sha256: string) => `/api/hub/modules/bundles/${sha256}`,
  run: (moduleId: string) => `/api/hub/modules/${moduleId}/run`,
} as const

/** POST /api/hub/modules/publish. */
export const hubModulePublishV1 = z.strictObject({
  v: z.literal(1),
  module_id: moduleIdSchema,
  version: z.string().regex(SEMVER, 'MAJOR.MINOR.PATCH'),
  commit: z.string().regex(HEX40, '40 lowercase hex'),
  bundle_sha256: bundleShaSchema,
  /** The parsed module.yaml as JSON; the hub compares it with the bundle's own. */
  manifest: z.record(z.string(), z.unknown()),
  bundle_b64: z.string().regex(BASE64, 'base64'),
  /** The publishing box's CORE_API_VERSION. */
  core_api: z.string().regex(SEMVER, 'MAJOR.MINOR.PATCH'),
  app_version: z.string().min(1).max(40),
})
export type HubModulePublishV1 = z.output<typeof hubModulePublishV1>

/** PUT /api/hub/modules/:module_id/run — the box's run state of one release. */
export const hubModuleRunV1 = z.strictObject({
  v: z.literal(1),
  bundle_sha256: bundleShaSchema,
  state: moduleRunStateSchema,
})
export type HubModuleRunV1 = z.output<typeof hubModuleRunV1>

/**
 * What a problem names: the six hub checks of §6.2, plus `commit` for the 409
 * (a commit pins one bundle).
 */
export const MODULE_HUB_CHECKS = ['bundle', 'manifest', 'license', 'core_api', 'uses', 'secrets', 'commit'] as const
export type ModuleHubCheck = (typeof MODULE_HUB_CHECKS)[number]

export const hubProblemSchema = z.strictObject({
  check: z.enum(MODULE_HUB_CHECKS),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  message: z.string(),
})
export type HubProblem = z.output<typeof hubProblemSchema>

/** 201 / 200 answer of a publish. */
export const hubPublishAnswer = z.strictObject({ receipt: moduleReceiptSchema })

/** 409 / 413 / 422 answer of a publish: every problem found. */
export const hubRefusalAnswer = z.strictObject({
  error: z.string(),
  code: z.enum(['conflict', 'too_large', 'refused']),
  problems: z.array(hubProblemSchema).min(1),
})
export type HubRefusalAnswer = z.output<typeof hubRefusalAnswer>

export const hubRunView = z.strictObject({
  install_id: z.string(),
  bundle_sha256: bundleShaSchema,
  version: z.string(),
  state: moduleRunStateSchema,
  reported_at: z.iso.datetime(),
})
export type HubRunView = z.output<typeof hubRunView>

/** 200 answer of a run report: which installs run the module (any of its versions). */
export const hubRunAnswer = z.strictObject({ module_id: z.string(), runs: z.array(hubRunView) })
export type HubRunAnswer = z.output<typeof hubRunAnswer>

/** The largest publish body the hub reads: the packed bundle as base64 plus room for the manifest. */
export const MAX_PUBLISH_BODY_BYTES = Math.ceil(BUNDLE_LIMITS.packedBytes / 3) * 4 + 512 * 1024
