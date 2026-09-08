export type KernelErrorCode =
  | 'permission_denied'
  | 'approval_required'
  | 'unknown_tool'
  | 'duplicate_tool'
  | 'invalid_input'
  | 'invalid_output'
  | 'module_inactive'
  | 'run_in_progress'

const KNOWN_CODES: readonly KernelErrorCode[] = [
  'permission_denied',
  'approval_required',
  'unknown_tool',
  'duplicate_tool',
  'invalid_input',
  'invalid_output',
  'module_inactive',
  'run_in_progress',
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
}

const PROBLEM_STATUS: Partial<Record<KernelErrorCode, number>> = {
  invalid_input: 400,
  invalid_output: 400,
  unknown_tool: 404,
  permission_denied: 403,
  module_inactive: 403,
  approval_required: 403,
  run_in_progress: 409,
  duplicate_tool: 409,
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

  constructor(code: KernelErrorCode, message: string) {
    super(message)
    this.name = 'KernelError'
    this.code = code
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
