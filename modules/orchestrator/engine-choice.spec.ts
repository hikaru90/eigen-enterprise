import { describe, expect, it } from 'vitest'
import {
  engineForProvider,
  orchestratorEnginePinFromEnv,
  resolveDispatchEngine,
} from './engine-choice'

describe('orchestratorEnginePinFromEnv (operator pin)', () => {
  it('unset = no pin: the per-provider choice recorded at connect time decides', () => {
    expect(orchestratorEnginePinFromEnv({})).toBeNull()
    expect(orchestratorEnginePinFromEnv({ EE_ORCHESTRATOR_ENGINE: ' ' })).toBeNull()
  })
  it('pins either engine explicitly', () => {
    expect(orchestratorEnginePinFromEnv({ EE_ORCHESTRATOR_ENGINE: 'durable' })).toBe('durable')
    expect(orchestratorEnginePinFromEnv({ EE_ORCHESTRATOR_ENGINE: 'builtin-json' })).toBe('builtin-json')
  })
  it('fails loud on anything else', () => {
    expect(() => orchestratorEnginePinFromEnv({ EE_ORCHESTRATOR_ENGINE: 'pi' })).toThrow(/must be one of/)
  })
})

describe('engineForProvider (chosen once, at provider connect time)', () => {
  it('OpenAI-compatible providers can carry tool calls → durable', () => {
    for (const provider of ['openrouter', 'eurouter', 'openai', 'github_copilot']) {
      expect(engineForProvider(provider)).toEqual({ engine: 'durable', reason: 'openai_compatible_tools' })
    }
  })
  it('subscription sign-ins on API-shape adapters cannot carry tools → builtin-json, reason recorded', () => {
    for (const provider of ['anthropic', 'openai_codex']) {
      expect(engineForProvider(provider)).toEqual({ engine: 'builtin-json', reason: 'api_shape_no_tools' })
    }
  })
})

describe('resolveDispatchEngine', () => {
  it('the operator pin wins over the recorded choice', () => {
    expect(resolveDispatchEngine({ pin: 'builtin-json', recorded: 'durable' })).toBe('builtin-json')
    expect(resolveDispatchEngine({ pin: 'durable', recorded: 'builtin-json' })).toBe('durable')
  })
  it('without a pin, the recorded per-provider choice decides', () => {
    expect(resolveDispatchEngine({ pin: null, recorded: 'durable' })).toBe('durable')
    expect(resolveDispatchEngine({ pin: null, recorded: 'builtin-json' })).toBe('builtin-json')
  })
  it('no connected provider (platform billing / no human) runs the engine of record', () => {
    expect(resolveDispatchEngine({ pin: null, recorded: null })).toBe('builtin-json')
  })
})
