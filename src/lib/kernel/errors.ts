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
