import { describe, expect, it } from 'vitest'
import { orchestratorEngineFromEnv } from './engine-choice'

describe('orchestratorEngineFromEnv', () => {
  it('builtin-json is the engine of record; durable is an explicit opt-in', () => {
    expect(orchestratorEngineFromEnv({})).toBe('builtin-json')
    expect(orchestratorEngineFromEnv({ EE_ORCHESTRATOR_ENGINE: 'durable' })).toBe('durable')
  })
  it('fails loud on anything else', () => {
    expect(() => orchestratorEngineFromEnv({ EE_ORCHESTRATOR_ENGINE: 'pi' })).toThrow(/must be one of/)
  })
})
