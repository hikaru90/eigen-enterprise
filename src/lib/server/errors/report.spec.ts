import { describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { errorReport, GENERIC_SENTENCE, refusalReport } from './report'

describe('errorReport', () => {
  it('keeps the surface sentence and fills the agent half from the KernelError', () => {
    const err = new KernelError(
      'invalid_input',
      'invalid input for tool website.app_deploy: hosts.0: bad',
      {
        tool: 'website.app_deploy',
        issues: [{ path: 'hosts.0', message: 'bad' }],
      },
    )
    const r = errorReport(err, {
      attempted: 'Deploying an app',
      tool: 'website.app_deploy',
      input: {
        name: 'site',
        hosts: ['https://x/'],
        contract: { env: [{ key: 'A', value: 'secret' }] },
      },
      plain: () => 'Check the domains.',
    })
    expect(r.error).toBe('Check the domains.')
    expect(r.agent.code).toBe('invalid_input')
    expect(r.agent.tool).toBe('website.app_deploy')
    expect(r.agent.details).toEqual({
      tool: 'website.app_deploy',
      issues: [{ path: 'hosts.0', message: 'bad' }],
    })
    expect(JSON.stringify(r.agent.input)).not.toContain('secret')
    expect(r.agent.cause).toContain('hosts.0: bad')
    expect(r.agent.nextSteps.join('\n')).toContain('details.issues')
    expect(r.agent.nextSteps.join('\n')).toContain('ee tool run website.app_deploy --input')
  })

  it('falls back to the generic sentence and records the cause chain of any error', () => {
    const r = errorReport(new Error('outer', { cause: new Error('ECONNREFUSED') }), {
      attempted: 'Loading',
    })
    expect(r.error).toBe(GENERIC_SENTENCE)
    expect(r.agent.code).toBe('Error')
    expect(r.agent.cause).toBe('outer ← ECONNREFUSED')
    expect(r.agent.nextSteps.at(-1)).toContain('server journal')
  })

  it('keeps structured status/kind fields of non-kernel errors', () => {
    const err = Object.assign(new Error('GitHub 404'), { status: 404 })
    expect(errorReport(err, { attempted: 'x' }).agent.details).toEqual({ status: 404 })
  })

  it('lists the surface steps first', () => {
    const r = errorReport(new Error('x'), { attempted: 'x', nextSteps: ['First this.'] })
    expect(r.agent.nextSteps[0]).toBe('First this.')
  })
})

describe('refusalReport', () => {
  it('shapes a non-exception refusal with the same fields', () => {
    const r = refusalReport('GitHub does not accept the key yet.', {
      attempted: 'Checking a deploy key',
      tool: 'website.github_deploy_key_check',
      input: { repo: 'a/b', keyId: 'k1' },
    })
    expect(r.error).toBe('GitHub does not accept the key yet.')
    expect(r.agent.tool).toBe('website.github_deploy_key_check')
    expect(
      r.agent.nextSteps.some((s) => s.includes('ee tool run website.github_deploy_key_check')),
    ).toBe(true)
  })
})
