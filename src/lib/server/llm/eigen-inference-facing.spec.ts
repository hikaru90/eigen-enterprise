import { describe, expect, it } from 'vitest'
import { facingChatModel, facingErrorMessage } from './eigen-inference-facing'

describe('facingChatModel (wish 60bd7be2: eigenInference names no model or provider)', () => {
  it('on eigenInference only says eigenInference', () => {
    const out = facingChatModel({ provider: 'platform', model: 'mistral/deepseek-v4-1-flash-1017', routingRuleId: null, billing: 'platform', gatewayHost: 'api.opper.ai' })
    expect(out).toEqual({ provider: 'eigenInference', model: 'eigenInference', routingRuleId: null, billing: 'platform', gatewayHost: 'eigenInference' })
  })
  it('on the own key everything stays', () => {
    const own = { provider: 'openrouter', model: 'qwen/qwen3.8-flash', routingRuleId: null, billing: 'byok' as const, gatewayHost: 'openrouter.ai' }
    expect(facingChatModel(own)).toEqual(own)
  })
})

describe('facingErrorMessage', () => {
  const models = ['~deepseek/deepseek-flash-latest', 'mistral/deepseek-v4-1-flash-1017']
  it('replaces every model id and provider host the error names on eigenInference', () => {
    const msg = 'Upstream 503 from api.opper.ai for mistral/deepseek-v4-1-flash-1017 (OpenRouter: ~deepseek/deepseek-flash-latest busy)'
    const out = facingErrorMessage(msg, { eigenInference: true, modelIds: models, providerNames: ['api.opper.ai', 'OpenRouter', 'Opper'] })
    expect(out).toBe('Upstream 503 from eigenInference for eigenInference (eigenInference: eigenInference busy)')
  })
  it('leaves the message alone on the own key', () => {
    const msg = 'OpenRouter: qwen/qwen3.8-flash failed'
    expect(facingErrorMessage(msg, { eigenInference: false, modelIds: ['qwen/qwen3.8-flash'], providerNames: ['OpenRouter'] })).toBe(msg)
  })
})
