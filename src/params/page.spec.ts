import { describe, expect, it } from 'vitest'
import { match } from './page'

describe('page param matcher (the shell catch-all)', () => {
  it.each(['graph', 'memory/timeline', 'settings/agents', 'apiary'])('takes %s', (p) => {
    expect(match(p)).toBe(true)
  })
  it.each(['api', 'api/nope', '_app/x'])('leaves %s alone', (p) => {
    expect(match(p)).toBe(false)
  })
})
