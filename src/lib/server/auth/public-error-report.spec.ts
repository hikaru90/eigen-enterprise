import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { publicErrorReport } from './public-error-report'

describe('publicErrorReport (signed-out surfaces)', () => {
  it('keeps the sentence and gives the agent only attempted, code and next steps', () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.5:5432 for owner@kindred.test')
    const report = publicErrorReport('Could not send the code', {
      attempted: 'Sending a sign-in code from /login',
      err,
      nextSteps: ['Check the mail module.'],
    })
    expect(report.error).toBe('Could not send the code')
    expect(report.agent.attempted).toBe('Sending a sign-in code from /login')
    expect(report.agent.code).toBe('Error')
    expect(report.agent.nextSteps[0]).toBe('Check the mail module.')
    expect(report.agent).not.toHaveProperty('cause')
    expect(report.agent).not.toHaveProperty('details')
    expect(report.agent).not.toHaveProperty('input')
    expect(JSON.stringify(report.agent)).not.toContain('owner@kindred.test')
    expect(JSON.stringify(report.agent)).not.toContain('ECONNREFUSED')
  })

  it('uses the kernel code for a KernelError and no code for a plain refusal', () => {
    const kernel = publicErrorReport('No.', {
      attempted: 'Claiming the company',
      err: new KernelError('permission_denied', 'nope'),
    })
    expect(kernel.agent.code).toBe('permission_denied')
    const refusal = publicErrorReport('No.', { attempted: 'Claiming the company' })
    expect(refusal.agent).not.toHaveProperty('code')
    expect(refusal.agent.nextSteps.length).toBeGreaterThan(0)
  })
})
