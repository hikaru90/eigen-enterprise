import { describe, expect, it } from 'vitest'
import { KernelError, type KernelErrorCode } from './errors'

const EXPECTED: Record<KernelErrorCode, { status: number; title: string }> = {
  permission_denied: { status: 403, title: 'Permission denied' },
  approval_required: { status: 403, title: 'Approval required' },
  unknown_tool: { status: 404, title: 'Unknown tool' },
  duplicate_tool: { status: 409, title: 'Duplicate tool' },
  invalid_input: { status: 400, title: 'Invalid input' },
  invalid_output: { status: 400, title: 'Invalid output' },
  module_inactive: { status: 403, title: 'Module inactive' },
  run_in_progress: { status: 409, title: 'Run in progress' },
}

const CODES = Object.keys(EXPECTED) as KernelErrorCode[]

describe('KernelError.toProblemJson', () => {
  for (const code of CODES) {
    it(`maps ${code} to an RFC 9457 problem object`, () => {
      const problem = new KernelError(code, 'something failed').toProblemJson()
      expect(problem).toEqual({
        type: `urn:eigenenterprise:problem:${code}`,
        title: EXPECTED[code].title,
        status: EXPECTED[code].status,
        detail: 'something failed',
      })
    })
  }

  it('emits exactly the four RFC 9457 keys', () => {
    const problem = new KernelError('invalid_input', 'bad input').toProblemJson()
    expect(Object.keys(problem).sort()).toEqual(['detail', 'status', 'title', 'type'])
  })
})
