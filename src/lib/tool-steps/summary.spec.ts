import { describe, expect, it } from 'vitest'
import {
  isSecretKey,
  summarizeToolInput,
  summarizeToolResult,
  toolStepLabel,
  toolStepTarget,
} from './summary'

describe('isSecretKey', () => {
  it('hides key / token / secret / password fields in any case or separator', () => {
    for (const key of ['apiKey', 'api_key', 'ACCESS_TOKEN', 'refreshToken', 'client_secret', 'password', 'auth', 'Authorization']) {
      expect(isSecretKey(key), key).toBe(true)
    }
    for (const key of ['to', 'subject', 'query', 'title', 'tokensUsed']) {
      expect(isSecretKey(key), key).toBe(false)
    }
  })
})

describe('summarizeToolInput', () => {
  it('lists the fields briefly and never shows a secret value', () => {
    expect(summarizeToolInput({ to: 'mia@example.com', subject: 'Hi', apiKey: 'sk-live-123' })).toBe(
      'to: mia@example.com · subject: Hi · apiKey: [hidden]',
    )
    expect(summarizeToolInput({ nested: { token: 'x' } })).toBe('nested: {…}')
  })

  it('short lists show their values, long ones their count; long text is clipped', () => {
    expect(summarizeToolInput({ tags: ['a', 'b'] })).toBe('tags: a, b')
    expect(summarizeToolInput({ ids: [1, 2, 3, 4] })).toBe('ids: 4 items')
    const out = summarizeToolInput({ body: 'x'.repeat(500) })!
    expect(out.length).toBeLessThanOrEqual(70)
    expect(out.endsWith('…')).toBe(true)
  })

  it('no input is null', () => {
    expect(summarizeToolInput({})).toBeNull()
    expect(summarizeToolInput(undefined)).toBeNull()
  })
})

describe('summarizeToolResult', () => {
  it('a structured tool error is a failed step with its message', () => {
    expect(summarizeToolResult({ status: 'error', tool: 'x', code: 'invalid_input', message: 'title is required' })).toEqual({
      failed: true,
      summary: 'title is required',
    })
  })

  it('an approval-pending outcome is not a failure', () => {
    expect(summarizeToolResult({ status: 'approval_pending', tool: 'email.send_mail', message: '…' })).toEqual({
      failed: false,
      summary: 'Waiting for approval; it has not run yet.',
    })
  })

  it('lists and records summarize by shape, secrets hidden', () => {
    expect(summarizeToolResult([1, 2, 3])).toEqual({ failed: false, summary: '3 items' })
    expect(summarizeToolResult({ id: 't-1', items: [1, 2, 3, 4, 5], secret: 'shh' })).toEqual({
      failed: false,
      summary: 'id: t-1 · items: 5 items · secret: [hidden]',
    })
    expect(summarizeToolResult(null)).toEqual({ failed: false, summary: null })
  })
})

describe('toolStepTarget', () => {
  it('an ee `tool run` is the tool it runs, with its input', () => {
    expect(toolStepTarget('ee', { args: ['tool', 'run', 'drive.list'], input: { folder: 'x' } })).toEqual({
      tool: 'drive.list',
      input: { folder: 'x' },
    })
  })

  it('other ee commands stay ee with their command words', () => {
    expect(toolStepTarget('ee', { args: ['tool', 'help', 'reminders.list'] })).toEqual({
      tool: 'ee',
      input: { command: 'tool help reminders.list' },
    })
  })

  it('a direct registry tool is itself', () => {
    expect(toolStepTarget('memory.capture_thought', { raw: 'x' })).toEqual({ tool: 'memory.capture_thought', input: { raw: 'x' } })
  })
})

describe('toolStepLabel', () => {
  it('names a registry tool in words, with its area', () => {
    expect(toolStepLabel('memory.capture_thought')).toEqual({ title: 'Capture thought', area: 'Memory' })
    expect(toolStepLabel('ee')).toEqual({ title: 'Company CLI', area: null })
    expect(toolStepLabel('answer_question')).toEqual({ title: 'Answer question', area: null })
  })
})
