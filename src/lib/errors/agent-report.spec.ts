import { describe, expect, it } from 'vitest'
import { agentInstructions, redact, shownErrorOf } from './agent-report'

const seen = { page: '/m/website/apps/new', at: '2026-11-21T10:00:00.000Z' }

describe('redact', () => {
  it('replaces secret-named fields at any depth and keeps the rest', () => {
    expect(
      redact({
        name: 'site',
        apiKey: 'sk-1',
        nested: { githubToken: 'ghp', clientSecret: 's', password: 'p', value: 'v' },
        list: [{ token: 't', host: 'a.example.com' }],
      }),
    ).toEqual({
      name: 'site',
      apiKey: '[redacted]',
      nested: {
        githubToken: '[redacted]',
        clientSecret: '[redacted]',
        password: '[redacted]',
        value: '[redacted]',
      },
      list: [{ token: '[redacted]', host: 'a.example.com' }],
    })
  })

  it('leaves empty secret fields visible (an empty value is a finding, not a secret)', () => {
    expect(redact({ value: '', token: null })).toEqual({ value: '', token: null })
  })
})

describe('agentInstructions', () => {
  it('carries the sentence, page, time, tool, code, redacted input, details, cause and steps', () => {
    const text = agentInstructions(
      'Check the domain.',
      {
        attempted: 'Deploying an app',
        tool: 'website.app_deploy',
        input: { name: 'site', hosts: ['https://x/'] },
        code: 'invalid_input',
        details: { issues: [{ path: 'hosts.0', message: 'Invalid' }] },
        cause: 'invalid input for tool website.app_deploy: hosts.0: Invalid',
        nextSteps: ['Fix the host.'],
      },
      seen,
    )
    expect(text).toContain('The person saw: "Check the domain."')
    expect(text).toContain('Page: /m/website/apps/new')
    expect(text).toContain('Time: 2026-11-21T10:00:00.000Z')
    expect(text).toContain('Attempted: Deploying an app')
    expect(text).toContain('Kernel tool: website.app_deploy')
    expect(text).toContain('Error code: invalid_input')
    expect(text).toContain('"hosts.0"')
    expect(text).toContain('Cause: invalid input for tool website.app_deploy')
    expect(text).toContain('1. Fix the host.')
  })

  it('without a server report still says what was seen, where, when, and where to look', () => {
    const text = agentInstructions('Could not load the progress.', null, seen, 'Following a deploy')
    expect(text).toContain('Attempted: Following a deploy')
    expect(text).toContain('server sent no report')
    expect(text).not.toContain('Kernel tool:')
  })
})

describe('shownErrorOf', () => {
  it('reads the sentence and a valid agent report from an action answer', () => {
    const agent = { attempted: 'x', nextSteps: [] }
    expect(shownErrorOf({ action: 'deploy', error: 'No.', agent })).toEqual({ error: 'No.', agent })
  })
  it('is null without a sentence and drops an agent that is not a report', () => {
    expect(shownErrorOf({ ok: true })).toBeNull()
    expect(shownErrorOf({ error: '' })).toBeNull()
    expect(shownErrorOf({ error: 'No.', agent: 'junk' })).toEqual({ error: 'No.', agent: null })
  })
})
