export type KernelErrorCode =
  | 'permission_denied'
  | 'approval_required'
  | 'unknown_tool'
  | 'duplicate_tool'
  | 'invalid_input'
  | 'invalid_output'
  | 'module_inactive'
  | 'run_in_progress'
  | 'unknown_agent'
  | 'agent_disabled'
  | 'duplicate_agent'
  | 'unknown_engine'
  | 'onboarding_inactive'
  | 'duplicate_engine'
  | 'budget_exceeded'
  | 'unknown_principal'
  | 'core_module'
  | 'unknown_module'
  | 'module_required'
  | 'module_switched_off'
  | 'human_decision_required'
  | 'not_configured'
  | 'no_person'
  | 'invalid_principal'
  | 'turn_not_editable'
  | 'invalid_agent'
  | 'invalid_instructions'
  | 'no_spend_ledger'
  | 'agent_acts_as_itself'
  | 'agent_acts_as_person'
  // Company modules (plan/phase-upgrades-u2.md §4.6): the eem/1 error codes.
  | 'module_use_undeclared'
  | 'module_not_running'
  | 'module_timeout'
  | 'module_protocol'
  | 'module_no_person'
  | 'module_unreceipted'
  | 'module_sharing_not_accepted'
  | 'module_needs_admin_click'
  | 'hub_unavailable'
  | 'data_not_found'
  | 'data_conflict'
  | 'data_quota'

const KNOWN_CODES: readonly KernelErrorCode[] = [
  'permission_denied',
  'approval_required',
  'unknown_tool',
  'duplicate_tool',
  'invalid_input',
  'invalid_output',
  'module_inactive',
  'run_in_progress',
  'unknown_agent',
  'agent_disabled',
  'duplicate_agent',
  'unknown_engine',
  'duplicate_engine',
  'budget_exceeded',
  'onboarding_inactive',
  'unknown_principal',
  'core_module',
  'unknown_module',
  'module_required',
  'module_switched_off',
  'human_decision_required',
  'not_configured',
  'no_person',
  'invalid_principal',
  'turn_not_editable',
  'invalid_agent',
  'invalid_instructions',
  'no_spend_ledger',
  'agent_acts_as_itself',
  'agent_acts_as_person',
  'module_use_undeclared',
  'module_not_running',
  'module_timeout',
  'module_protocol',
  'module_no_person',
  'module_unreceipted',
  'module_sharing_not_accepted',
  'module_needs_admin_click',
  'hub_unavailable',
  'data_not_found',
  'data_conflict',
  'data_quota',
]

/** Exhaustive per code — adding a KernelErrorCode without a title is a type error. */
const PROBLEM_TITLES: Record<KernelErrorCode, string> = {
  permission_denied: 'Permission denied',
  approval_required: 'Approval required',
  unknown_tool: 'Unknown tool',
  duplicate_tool: 'Duplicate tool',
  invalid_input: 'Invalid input',
  invalid_output: 'Invalid output',
  module_inactive: 'Module inactive',
  run_in_progress: 'Run in progress',
  unknown_agent: 'Unknown agent',
  agent_disabled: 'Agent disabled',
  duplicate_agent: 'Duplicate agent',
  unknown_engine: 'Unknown loop engine',
  duplicate_engine: 'Duplicate loop engine',
  budget_exceeded: 'Spend budget exceeded',
  onboarding_inactive: 'Onboarding hand-off not active',
  unknown_principal: 'Unknown principal',
  core_module: 'Core module',
  unknown_module: 'Unknown module',
  module_required: 'Module required',
  module_switched_off: 'Switched off by a person',
  human_decision_required: 'Only a person can decide this',
  not_configured: 'Not set up',
  no_person: 'No person to act as',
  invalid_principal: 'Malformed principal',
  turn_not_editable: 'Message cannot be edited',
  invalid_agent: 'Malformed agent',
  invalid_instructions: 'No instructions for this turn',
  no_spend_ledger: 'No spend ledger',
  agent_acts_as_itself: 'Agent acts as itself',
  agent_acts_as_person: 'Agent acts as a person',
  module_use_undeclared: 'Not declared in module.yaml',
  module_not_running: 'Module not running',
  module_timeout: 'Module did not answer in time',
  module_protocol: 'Module protocol violation',
  module_no_person: 'No person for the module to act as',
  module_unreceipted: 'Module version not published',
  module_sharing_not_accepted: 'Module sharing not accepted',
  module_needs_admin_click: 'Needs an admin’s own click',
  hub_unavailable: 'Module hub unavailable',
  data_not_found: 'Module data not found',
  data_conflict: 'Module data changed meanwhile',
  data_quota: 'Module data over its limit',
}

const PROBLEM_STATUS: Partial<Record<KernelErrorCode, number>> = {
  invalid_input: 400,
  invalid_output: 400,
  onboarding_inactive: 409,
  unknown_tool: 404,
  permission_denied: 403,
  module_inactive: 403,
  approval_required: 403,
  run_in_progress: 409,
  duplicate_tool: 409,
  unknown_agent: 404,
  agent_disabled: 409,
  duplicate_agent: 409,
  unknown_engine: 500,
  duplicate_engine: 409,
  budget_exceeded: 402,
  // Module switching that would break the system: the core, or a module another needs.
  core_module: 409,
  unknown_module: 404,
  module_required: 409,
  // A plugin a person switched off: only a person (owner/admin) switches it back on.
  module_switched_off: 409,
  // An always-ask approval (approvalAlways): only a human principal decides it.
  human_decision_required: 403,
  // The company has not set this up yet (no owner, a feature off on this deployment).
  not_configured: 409,
  // The company brain acts only as a person (CB3): a run that names none does not run.
  no_person: 400,
  invalid_principal: 400,
  // Edit-and-resend names a turn the conversation no longer carries (or never tagged).
  turn_not_editable: 409,
  // An agent config the runtime cannot run (no declared instructions/identity, a colon in its id, two caps).
  invalid_agent: 400,
  invalid_instructions: 400,
  // A self-acting agent (AI co-worker) needs the real cost ledger to be capped; none is wired.
  no_spend_ledger: 500,
  // The dispatch entry does not match who the agent acts as (dispatch vs dispatchAsAgent).
  agent_acts_as_itself: 409,
  agent_acts_as_person: 409,
  // Company modules (plan/phase-upgrades-u2.md §4.6).
  module_use_undeclared: 403,
  module_not_running: 409,
  module_timeout: 504,
  module_protocol: 400,
  module_no_person: 403,
  module_unreceipted: 409,
  module_sharing_not_accepted: 409,
  module_needs_admin_click: 403,
  hub_unavailable: 503,
  data_not_found: 404,
  data_conflict: 409,
  data_quota: 413,
}

/** RFC 9457 problem-details object as produced by `KernelError.toProblemJson`. */
export type ProblemJson = {
  type: string
  title: string
  status: number
  detail: string
}

export class KernelError extends Error {
  readonly code: KernelErrorCode
  /** Structured, machine-readable context (e.g. the inactive module id) — never parsed from the message. */
  readonly details: Record<string, unknown> | undefined

  constructor(code: KernelErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'KernelError'
    this.code = code
    this.details = details
  }

  toProblemJson(): ProblemJson {
    return {
      type: `urn:eigenenterprise:problem:${this.code}`,
      title: PROBLEM_TITLES[this.code],
      status: PROBLEM_STATUS[this.code] ?? 500,
      detail: this.message,
    }
  }
}

export function isKernelErrorCode(value: string): value is KernelErrorCode {
  return (KNOWN_CODES as readonly string[]).includes(value)
}
