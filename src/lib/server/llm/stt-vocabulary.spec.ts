import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/db', () => ({ getDb: vi.fn() }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: vi.fn() }))

const { buildTranscriptionPrompt, STT_PROMPT_MAX_CHARS } = await import('./stt-vocabulary')

describe('buildTranscriptionPrompt', () => {
  it('names the company, the UI language as a hint (never a forced language) and the names', () => {
    expect(
      buildTranscriptionPrompt({
        companyName: 'Kindred Digital Labs',
        uiLanguage: 'de',
        names: ['Ony Example', 'Mira Musterfrau', 'Acme GmbH'],
      }),
    ).toBe(
      'Dictation in the workspace of Kindred Digital Labs. The speaker usually works in German, and may also speak other languages. Names that may come up: Ony Example, Mira Musterfrau, Acme GmbH.',
    )
  })

  it('drops empty and repeated names, and the company name itself', () => {
    expect(
      buildTranscriptionPrompt({ companyName: 'Acme', uiLanguage: null, names: [' Ada ', 'Ada', '', 'Acme', 'Bo'] }),
    ).toBe('Dictation in the workspace of Acme. Names that may come up: Ada, Bo.')
  })

  it('stays under the cap, cutting on a whole name', () => {
    const names = Array.from({ length: 200 }, (_, i) => `Person Number ${i}`)
    const prompt = buildTranscriptionPrompt({ companyName: 'Acme', uiLanguage: 'en', names })!
    expect(prompt.length).toBeLessThanOrEqual(STT_PROMPT_MAX_CHARS)
    expect(prompt).toMatch(/Person Number \d+\.$/)
  })

  it('nothing known: no prompt at all', () => {
    expect(buildTranscriptionPrompt({ companyName: null, uiLanguage: null, names: [] })).toBeNull()
  })

  it('an unknown language code is left out rather than guessed', () => {
    expect(buildTranscriptionPrompt({ companyName: null, uiLanguage: 'zz', names: ['Ada'] })).toBe(
      'Names that may come up: Ada.',
    )
  })
})
