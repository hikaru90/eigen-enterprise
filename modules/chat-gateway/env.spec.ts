import { describe, expect, it } from 'vitest'
import { chatGatewayEnv } from './env'

describe('chatGatewayEnv', () => {
  it('throws a loud error when TELEGRAM_BOT_TOKEN is absent', () => {
    expect(() => chatGatewayEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('throws when TELEGRAM_BOT_TOKEN is empty or blank', () => {
    expect(() => chatGatewayEnv({ TELEGRAM_BOT_TOKEN: '' })).toThrow(/TELEGRAM_BOT_TOKEN/)
    expect(() => chatGatewayEnv({ TELEGRAM_BOT_TOKEN: '   ' })).toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('returns the bot token when present', () => {
    expect(chatGatewayEnv({ TELEGRAM_BOT_TOKEN: '123:abc' })).toEqual({ botToken: '123:abc' })
  })
})
