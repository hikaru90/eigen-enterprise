export type KernelErrorCode =
  | 'permission_denied'
  | 'approval_required'
  | 'unknown_tool'
  | 'duplicate_tool'
  | 'invalid_input'

const KNOWN_CODES: readonly KernelErrorCode[] = [
  'permission_denied',
  'approval_required',
  'unknown_tool',
  'duplicate_tool',
  'invalid_input',
]

export class KernelError extends Error {
  readonly code: KernelErrorCode

  constructor(code: KernelErrorCode, message: string) {
    super(message)
    this.name = 'KernelError'
    this.code = code
  }
}

export function isKernelErrorCode(value: string): value is KernelErrorCode {
  return (KNOWN_CODES as readonly string[]).includes(value)
}
