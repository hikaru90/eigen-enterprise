import { AI_TASKS } from '$lib/ai-usage/tasks'
import type { KernelErrorCode } from '$lib/kernel/errors'
import { COWORKER_STOP_REASONS, COWORKER_TRIGGER_KINDS } from '$lib/server/db/coworkers.schema'
import lock from '../../contracts/core-api.lock.json'

/**
 * The closed sets of a Tier A span (plan/traces-phone-home.md §2). Every value a span carries is
 * one of these, a number, a version or a day — or an open value that the box's Jev gate
 * (value-kind.ts) classified `usage_meta`. Client-safe: no server imports beyond schema constants.
 */

export const SPAN_KINDS = ['run', 'llm_call', 'tool_call', 'job', 'upgrade'] as const
export type SpanKind = (typeof SPAN_KINDS)[number]

export const SPAN_OUTCOMES = ['ok', 'error', 'stopped', 'rolled_back'] as const
export type SpanOutcome = (typeof SPAN_OUTCOMES)[number]

export const AUDIT_CLASSES = ['read', 'mutate', 'external'] as const
/** How a tool call reached the registry: a person directly, the brain for a person, a company module. */
export const VIAS = ['person', 'brain', 'module'] as const
export type Via = (typeof VIAS)[number]

/** activity_call_log.provider values a model call has (activity/gateway-providers.ts). */
export const PROVIDER_KINDS = ['eurouter', 'openrouter', 'platform', 'llm'] as const

/** The jobs of user_job_queue (brain.schema.ts userJobTypeEnum), mirrored: a spec keeps both equal. */
export const JOB_TYPES = [
  'overnight_consolidation',
  'webhook_delivery',
  'onboarding_grounding_push',
  'erpnext_invoice_push',
  'calendar_mail_proposal',
  'company_export',
  'module_hub_summarize',
] as const

/** The steps an upgrade can end in (ee/src/upgrade-job.ts OUTCOME_STEPS). */
export const UPGRADE_STEPS = ['verifying', 'safety-copy', 'backup', 'installing', 'watching', 'rolling-back', 'done'] as const

export const RUN_KINDS = [
  ...COWORKER_TRIGGER_KINDS.map((k) => `coworker:${k}` as const),
  ...JOB_TYPES.map((j) => `job:${j}` as const),
  'upgrade',
] as const

/** Every KernelErrorCode, at runtime; the type check below fails when errors.ts gains one not listed. */
export const KERNEL_ERROR_CODES = [
  'permission_denied', 'approval_required', 'unknown_tool', 'duplicate_tool', 'invalid_input', 'invalid_output',
  'module_inactive', 'run_in_progress', 'unknown_agent', 'agent_disabled', 'duplicate_agent', 'unknown_engine',
  'onboarding_inactive', 'duplicate_engine', 'budget_exceeded', 'unknown_principal', 'core_module', 'unknown_module',
  'module_required', 'module_switched_off', 'human_decision_required', 'not_configured', 'no_person',
  'invalid_principal', 'turn_not_editable', 'invalid_agent', 'invalid_instructions', 'no_spend_ledger',
  'agent_acts_as_itself', 'agent_acts_as_person', 'module_use_undeclared', 'module_not_running', 'module_timeout',
  'module_protocol', 'module_no_person', 'module_unreceipted', 'module_sharing_not_accepted',
  'module_needs_admin_click', 'hub_unavailable', 'data_not_found', 'data_conflict', 'data_quota',
] as const satisfies readonly KernelErrorCode[]
type MissingKernelCode = Exclude<KernelErrorCode, (typeof KERNEL_ERROR_CODES)[number]>
const kernelCodesComplete: [MissingKernelCode] extends [never] ? true : MissingKernelCode = true
void kernelCodesComplete

export const ERROR_CODES = [
  ...KERNEL_ERROR_CODES,
  ...COWORKER_STOP_REASONS,
  ...UPGRADE_STEPS.map((s) => `upgrade_step:${s}` as const),
  'job_failed',
  'other',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

/** Core tool names: the registry's public contract (contracts/core-api.lock.json). */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set((lock as { tools: { name: string }[] }).tools.map((t) => t.name))
/** Log contexts: the closed AI task catalog ($lib/ai-usage/tasks), every model call names one. */
export const LOG_CONTEXTS: ReadonlySet<string> = new Set(Object.keys(AI_TASKS))

/**
 * The shape an open value must have before it is even asked about: a module tool name, a model id.
 * Structure only (no meaning): a value of another shape is withheld, never classified or sent.
 */
export const OPEN_VALUE_SHAPES = {
  tool: /^[a-z][a-z0-9_-]{0,60}\.[a-z][a-z0-9_]{0,60}$/,
  model: /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/,
} as const
export type OpenField = keyof typeof OPEN_VALUE_SHAPES
export const OPEN_FIELDS = Object.keys(OPEN_VALUE_SHAPES) as OpenField[]

/** A release as ee names it (eigenenterprise-<version>-<sha>), or a bare semver. */
export const VERSION_SHAPE = /^(eigenenterprise-)?\d+\.\d+\.\d+(-[0-9a-z.]{1,40})?$/
