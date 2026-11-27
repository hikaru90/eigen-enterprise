import type { EngineContext } from '../engine'
import { describe, expect, it } from 'vitest'
import { DurableLoopEngine, DurableRunError, type DurableEngineHarness } from './durable'

describe('DurableRunError', () => {
  it('preserves the exact message when detail is omitted', () => {
    const err = new DurableRunError('model_error')
    expect(err.name).toBe('DurableRunError')
    expect(err.reason).toBe('model_error')
    expect(err.detail).toBeUndefined()
    expect(err.message).toBe('durable agent run ended without an answer: model_error')
  })

  it('includes a string detail cleanly', () => {
    const err = new DurableRunError('model_error', 'LLM HTTP 400: unsupported temperature')
    expect(err.message).toBe(
      'durable agent run ended without an answer: model_error: LLM HTTP 400: unsupported temperature',
    )
  })

  it('truncates string detail longer than 240 chars', () => {
    const longDetail = 'x'.repeat(300)
    const err = new DurableRunError('model_error', longDetail)
    const prefix = 'durable agent run ended without an answer: model_error: '
    expect(err.message.startsWith(prefix)).toBe(true)
    const suffix = err.message.slice(prefix.length)
    expect(suffix.length).toBeLessThanOrEqual(240)
    expect(suffix.endsWith('...')).toBe(true)
  })

  it('extracts string message from object detail and Error instances', () => {
    const fromObj = new DurableRunError('model_error', { message: 'invalid tool name', code: 400 })
    expect(fromObj.message).toBe('durable agent run ended without an answer: model_error: invalid tool name')

    const fromError = new DurableRunError('model_error', new Error('gateway timeout'))
    expect(fromError.message).toBe('durable agent run ended without an answer: model_error: gateway timeout')
  })

  it('serializes object detail without message, redacting secrets and truncating to 240 chars', () => {
    const err = new DurableRunError('model_error', {
      status: 400,
      max_tokens: 1024,
      error: 'bad_request',
      api_key: 'sk-secret-1',
      apiKey: 'sk-secret-2',
      access_token: 'tok-1',
      accessToken: 'tok-2',
      client_secret: 'sec-1',
      clientSecret: 'sec-2',
      password: 'pw-1',
      dbPassword: 'pw-2',
      auth: { secret_key: 'sec-3' },
    })
    expect(err.message).toContain('"status":400')
    expect(err.message).toContain('"max_tokens":1024')
    expect(err.message).toContain('"error":"bad_request"')
    expect(err.message).not.toContain('sk-secret-1')
    expect(err.message).not.toContain('sk-secret-2')
    expect(err.message).not.toContain('tok-1')
    expect(err.message).not.toContain('tok-2')
    expect(err.message).not.toContain('sec-1')
    expect(err.message).not.toContain('sec-2')
    expect(err.message).not.toContain('sec-3')
    expect(err.message).not.toContain('pw-1')
    expect(err.message).not.toContain('pw-2')
    expect(err.message).toContain('[REDACTED]')

    const longObj = new DurableRunError('model_error', {
      status: 400,
      payload: 'z'.repeat(400),
    })
    const prefix = 'durable agent run ended without an answer: model_error: '
    expect(longObj.message.slice(prefix.length).length).toBeLessThanOrEqual(240)
    expect(longObj.message.endsWith('...')).toBe(true)
  })

  it('handles cyclic object detail safely without throwing', () => {
    const cyclic: Record<string, unknown> = { error: 'boom' }
    cyclic.self = cyclic
    const err = new DurableRunError('model_error', cyclic)
    expect(err.message).toBe(
      'durable agent run ended without an answer: model_error: {"error":"boom","self":"[Circular]"}',
    )
  })

  it('surfaces formatted detail when DurableLoopEngine.run settles unanswered', async () => {
    const harness: DurableEngineHarness = {
      conversation: async () => ({
        id: '1',
        submitAndSettle: async () => ({
          status: 'unanswered',
          reason: 'model_error',
          detail: 'HTTP 400 bad request',
        }),
        supersedeTurn: async () => {},
      }),
      startBackgroundRun: async () => {
        throw new Error('unused')
      },
    }
    const engine = new DurableLoopEngine({ harness, instructions: 'You are a test agent.' })
    const ctx = {
      agent: { id: 'cw-test', task: 'coworkers.turn' },
      instructions: { kind: 'own', text: 'Run test.' },
      llmUserId: 'cw-test',
      listTools: () => [],
      executeTool: async () => ({}),
    } as unknown as EngineContext

    await expect(engine.run('s1', 'hi', ctx)).rejects.toThrow(
      'durable agent run ended without an answer: model_error: HTTP 400 bad request',
    )
  })
})
