import { describe, expect, it } from 'vitest'
import { ownerModuleBlurb } from './module-copy'

const JARGON = /kernel|GTD|hybrid retrieval|substrate|owlery|LLM|entity extraction/i

describe('owner-facing module blurbs', () => {
  it.each(['website', 'email', 'brand', 'memory', 'members', 'drive', 'recap', 'chat-gateway', 'assistant'])(
    '%s reads in plain words',
    (id) => {
      const text = ownerModuleBlurb(id, 'Brand kernel: GTD fallback')
      expect(text).not.toMatch(JARGON)
      expect(text.length).toBeGreaterThan(20)
    },
  )
  it('falls back to the manifest description for an unknown module', () => {
    expect(ownerModuleBlurb('weather', 'Forecasts.')).toBe('Forecasts.')
  })
})
