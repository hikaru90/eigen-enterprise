import { describe, expect, it, vi } from 'vitest'
import { expandSeeds } from '../style-format/expand'
import { validSeeds } from '../style-format/seeds.spec'
import {
  brandExtractModelFromEnv,
  proposeCandidates,
  proposeCandidatesFromGuide,
  type ChatCompletionFn,
} from './propose'

function validSeedsResponse(): string {
  return JSON.stringify({ seeds: validSeeds({ chromaCurve: 'muted' }) })
}

function chatResponse(content: string): unknown {
  return { choices: [{ message: { role: 'assistant', content } }] }
}

function mockChat(
  impl: (temperature: number) => string,
): ChatCompletionFn & { mock: ReturnType<typeof vi.fn> } {
  const fn = vi.fn(async (input: { temperature?: number }) =>
    chatResponse(impl(input.temperature ?? 0)),
  )
  return fn as unknown as ChatCompletionFn & { mock: ReturnType<typeof vi.fn> }
}

describe('brandExtractModelFromEnv', () => {
  it('returns the trimmed model when set', () => {
    expect(brandExtractModelFromEnv({ BRAND_EXTRACT_MODEL: ' zed-industries/claude ' })).toBe(
      'zed-industries/claude',
    )
  })

  it('throws naming the env var when unset or blank (D2 precedent, no fallback)', () => {
    expect(() => brandExtractModelFromEnv({})).toThrow(/BRAND_EXTRACT_MODEL/)
    expect(() => brandExtractModelFromEnv({ BRAND_EXTRACT_MODEL: '  ' })).toThrow(
      /BRAND_EXTRACT_MODEL/,
    )
  })
})

describe('proposeCandidates', () => {
  it('makes three gateway calls with the pinned temperature ladder and json_object mode', async () => {
    const chat = mockChat(() => validSeedsResponse())
    const candidates = await proposeCandidates(
      { chatCompletion: chat },
      { userId: 'owner-1', digest: 'SITE: x', priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm1' } },
    )
    expect(candidates).toHaveLength(3)
    expect(chat.mock.calls.map((c) => c[0].temperature)).toEqual([0.4, 0.7, 1.0])
    for (const call of chat.mock.calls) {
      expect(call[0].modelOverride).toBe('m1')
      expect(call[0].responseFormat).toBe('json_object')
      expect(call[0].userId).toBe('owner-1')
      expect(call[0].logContext).toBe('brand_extract')
      expect(call[0].aiSessionId).toBeUndefined()
    }
  })

  it('labels candidates Color-led / Type-led / Structure-led and expands seeds', async () => {
    const chat = mockChat(() => validSeedsResponse())
    const candidates = await proposeCandidates(
      { chatCompletion: chat },
      { userId: 'u', digest: 'd', priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
    )
    expect(candidates.map((c) => c.label)).toEqual(['Color-led', 'Type-led', 'Structure-led'])
    for (const candidate of candidates) {
      if (!('seeds' in candidate)) throw new Error('expected a valid candidate')
      expect(candidate.cssVars['--background']).toMatch(/^oklch\(/)
      expect(expandSeeds(candidate.seeds).cssVars).toEqual(candidate.cssVars)
    }
  })

  it('injects the seed shape, digest and prior verdicts into the prompts', async () => {
    const chat = mockChat(() => validSeedsResponse())
    await proposeCandidates(
      { chatCompletion: chat },
      {
        userId: 'u',
        digest: 'SITE: Kindred — unique palette evidence',
        priorRounds: [
          {
            round: 1,
            verdict: { chosen: 0, note: 'too corporate' },
            candidateLabels: ['Color-led', 'Type-led', 'Structure-led'],
          },
        ],
        env: { BRAND_EXTRACT_MODEL: 'm' },
      },
    )
    const [system, user] = chat.mock.calls[0][0].messages
    expect(system.role).toBe('system')
    expect(system.content).toContain('seedColor')
    expect(system.content).toContain('ONLY JSON')
    expect(user.content).toContain('Kindred — unique palette evidence')
    expect(user.content).toContain('Round 1')
    expect(user.content).toContain('chosen: Color-led')
    expect(user.content).toContain('too corporate')
  })

  it('records an invalid candidate as {label, error} instead of failing the round', async () => {
    const chat = mockChat((temperature) =>
      temperature === 0.7 ? 'not json at all' : validSeedsResponse(),
    )
    const candidates = await proposeCandidates(
      { chatCompletion: chat },
      { userId: 'u', digest: 'd', priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
    )
    expect(candidates).toHaveLength(3)
    const invalid = candidates[1]
    expect(invalid.label).toBe('Type-led')
    expect('error' in invalid && invalid.error.length > 0).toBe(true)
  })

  it('throws loud when all three candidates are invalid', async () => {
    const chat = mockChat(() => 'garbage')
    await expect(
      proposeCandidates(
        { chatCompletion: chat },
        { userId: 'u', digest: 'd', priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
      ),
    ).rejects.toThrow(/all three extraction candidates invalid/)
  })

  it('surfaces zod violations of the seed shape as loud errors (all-invalid -> throw)', async () => {
    const bad = JSON.stringify({ seeds: { ...validSeeds(), grain: 42 } })
    const chat = mockChat(() => bad)
    await expect(
      proposeCandidates(
        { chatCompletion: chat },
        { userId: 'u', digest: 'd', priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
      ),
    ).rejects.toThrow(/grain/)
  })

  it('fails loud before any gateway call when the model env is unset', async () => {
    const chat = mockChat(() => validSeedsResponse())
    await expect(
      proposeCandidates(
        { chatCompletion: chat },
        { userId: 'u', digest: 'd', priorRounds: [], env: {} },
      ),
    ).rejects.toThrow(/BRAND_EXTRACT_MODEL/)
    expect(chat.mock.calls).toHaveLength(0)
  })
})

describe('proposeCandidatesFromGuide', () => {
  const pdfGuide = {
    filename: 'Kindred CI.pdf',
    mime: 'application/pdf' as const,
    base64: 'JVBERi0xLjc=',
  }
  const pngGuide = { filename: 'moodboard.png', mime: 'image/png' as const, base64: 'iVBORw0KGgo=' }

  it('sends the guide with every lens call: same ladder, model env, json mode, the existing seed shape', async () => {
    const chat = mockChat(() => validSeedsResponse())
    const candidates = await proposeCandidatesFromGuide(
      { chatCompletion: chat },
      {
        userId: 'owner-1',
        guide: pdfGuide,
        priorRounds: [],
        env: { BRAND_EXTRACT_MODEL: 'vision-m' },
        aiSessionId: 's-1',
      },
    )
    expect(candidates.map((c) => c.label)).toEqual(['Color-led', 'Type-led', 'Structure-led'])
    expect(chat.mock.calls.map((c) => c[0].temperature)).toEqual([0.4, 0.7, 1.0])
    for (const call of chat.mock.calls) {
      const input = call[0]
      expect(input.modelOverride).toBe('vision-m')
      expect(input.responseFormat).toBe('json_object')
      expect(input.logContext).toBe('brand_extract_guide')
      expect(input.aiSessionId).toBe('s-1')
      const [system, user] = input.messages
      expect(system.content).toContain('brand guide')
      expect(system.content).toContain('seedColor')
      expect(system.attachments).toBeUndefined()
      expect(user.content).toContain('Kindred CI.pdf')
      expect(user.attachments).toEqual([
        { type: 'pdf', filename: 'Kindred CI.pdf', base64: 'JVBERi0xLjc=' },
      ])
    }
    for (const candidate of candidates) {
      if (!('seeds' in candidate)) throw new Error('expected a valid candidate')
      expect(expandSeeds(candidate.seeds).cssVars).toEqual(candidate.cssVars)
    }
  })

  it('sends an image guide as an image attachment', async () => {
    const chat = mockChat(() => validSeedsResponse())
    await proposeCandidatesFromGuide(
      { chatCompletion: chat },
      { userId: 'u', guide: pngGuide, priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
    )
    expect(chat.mock.calls[0][0].messages[1].attachments).toEqual([
      { type: 'image', mime: 'image/png', base64: 'iVBORw0KGgo=' },
    ])
  })

  it('feeds prior verdicts and corrective notes into the next round', async () => {
    const chat = mockChat(() => validSeedsResponse())
    await proposeCandidatesFromGuide(
      { chatCompletion: chat },
      {
        userId: 'u',
        guide: pdfGuide,
        priorRounds: [
          {
            round: 1,
            verdict: { chosen: null, note: 'the green is too loud' },
            candidateLabels: ['Color-led', 'Type-led', 'Structure-led'],
          },
        ],
        env: { BRAND_EXTRACT_MODEL: 'm' },
      },
    )
    const user = chat.mock.calls[0][0].messages[1]
    expect(user.content).toContain('Round 1')
    expect(user.content).toContain('the green is too loud')
  })

  it('validates with the seed schema: invalid output is an error candidate, all invalid throws', async () => {
    const oneBad = mockChat((t) =>
      t === 1.0 ? JSON.stringify({ seeds: { ...validSeeds(), grain: 7 } }) : validSeedsResponse(),
    )
    const mixed = await proposeCandidatesFromGuide(
      { chatCompletion: oneBad },
      { userId: 'u', guide: pdfGuide, priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
    )
    expect('error' in mixed[2] && mixed[2].error).toMatch(/grain/)
    await expect(
      proposeCandidatesFromGuide(
        { chatCompletion: mockChat(() => 'nope') },
        { userId: 'u', guide: pdfGuide, priorRounds: [], env: { BRAND_EXTRACT_MODEL: 'm' } },
      ),
    ).rejects.toThrow(/all three extraction candidates invalid/)
  })

  it('fails loud before any call when the model env is unset', async () => {
    const chat = mockChat(() => validSeedsResponse())
    await expect(
      proposeCandidatesFromGuide(
        { chatCompletion: chat },
        { userId: 'u', guide: pdfGuide, priorRounds: [], env: {} },
      ),
    ).rejects.toThrow(/BRAND_EXTRACT_MODEL/)
    expect(chat.mock.calls).toHaveLength(0)
  })
})
