import { describe, expect, it } from 'vitest'
import { coworkerModelOptions } from './model-options'

describe('coworkerModelOptions (wish cd140a7a)', () => {
  it('offers no model on eigenInference', () => {
    expect(coworkerModelOptions('eigeninference')).toEqual([])
  })
  it("offers the pool's chat models on the company's own key", () => {
    const ids = coworkerModelOptions('byok').map((o) => o.id)
    expect(ids).toContain('~deepseek/deepseek-flash-latest')
    expect(ids.length).toBeGreaterThan(3)
  })
})
