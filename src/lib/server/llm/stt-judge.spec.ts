import { describe, expect, it, vi } from 'vitest'
import {
  buildTranscriptCheckMessages,
  judgeTranscript,
  parseTranscriptVerdict,
  STT_JUDGE_ATTEMPTS,
  STT_JUDGE_LOG_CONTEXT,
  toWritingSamples,
  WRITING_SAMPLE_LIMIT,
  WRITING_SAMPLE_MAX_CHARS,
} from './stt-judge'

const reply = (content: string) => ({ choices: [{ message: { content } }] })

describe('toWritingSamples', () => {
  it('drops empty bodies, keeps at most the limit, cuts each one short', () => {
    const long = 'x'.repeat(WRITING_SAMPLE_MAX_CHARS + 40)
    const bodies = ['  ', ' hallo zusammen ', long, ...Array.from({ length: 10 }, (_, i) => `m${i}`)]
    const samples = toWritingSamples(bodies)
    expect(samples).toHaveLength(WRITING_SAMPLE_LIMIT)
    expect(samples[0]).toBe('hallo zusammen')
    expect(samples[1]).toHaveLength(WRITING_SAMPLE_MAX_CHARS)
  })
})

describe('buildTranscriptCheckMessages', () => {
  it('shows the samples and the transcript, and names both verdicts in the schema', () => {
    const [system, user] = buildTranscriptCheckMessages({ transcript: 'ship it', writingSamples: ['guten morgen'] })
    expect(system!.content).toContain('"dictation"')
    expect(system!.content).toContain('"artefact"')
    expect(user!.content).toContain('"guten morgen"')
    expect(user!.content).toContain('"ship it"')
  })

  it('says so when there is no writing on record', () => {
    const [, user] = buildTranscriptCheckMessages({ transcript: 'hi', writingSamples: [] })
    expect(user!.content).toContain('No writing by this person is on record yet.')
  })
})

describe('parseTranscriptVerdict', () => {
  it('reads a fenced JSON verdict', () => {
    expect(parseTranscriptVerdict(reply('```json\n{"verdict":"artefact"}\n```'))).toBe('artefact')
  })

  it('rejects an off-catalog verdict', () => {
    expect(() => parseTranscriptVerdict(reply('{"verdict":"maybe"}'))).toThrow(/schema/)
  })
})

describe('judgeTranscript', () => {
  it('asks once in JSON mode at temperature 0 with its log context', async () => {
    const chat = vi.fn(async () => reply('{"verdict":"dictation","reason":"coherent"}'))
    await expect(judgeTranscript(chat, { userId: 'u1', transcript: 'hello', writingSamples: [] })).resolves.toBe('dictation')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', temperature: 0, responseFormat: 'json_object', logContext: STT_JUDGE_LOG_CONTEXT }),
    )
  })

  it('retries an invalid answer, then succeeds', async () => {
    const chat = vi.fn().mockResolvedValueOnce(reply('not json')).mockResolvedValueOnce(reply('{"verdict":"artefact"}'))
    await expect(judgeTranscript(chat, { userId: 'u1', transcript: 'ooo', writingSamples: [] })).resolves.toBe('artefact')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('fails loud after every attempt answered off-catalog — never passes the text through', async () => {
    const chat = vi.fn(async () => reply('{"verdict":"unsure"}'))
    await expect(judgeTranscript(chat, { userId: 'u1', transcript: 'x', writingSamples: [] })).rejects.toThrow(
      `failed ${STT_JUDGE_ATTEMPTS} times`,
    )
    expect(chat).toHaveBeenCalledTimes(STT_JUDGE_ATTEMPTS)
  })

  it('does not retry a gateway error (no provider, no credits)', async () => {
    const chat = vi.fn(async () => {
      throw new Error('LLM not configured')
    })
    await expect(judgeTranscript(chat, { userId: 'u1', transcript: 'x', writingSamples: [] })).rejects.toThrow('LLM not configured')
    expect(chat).toHaveBeenCalledTimes(1)
  })
})
