import type { JudgeChat } from '../judge'
import { describe, expect, it } from 'vitest'
import { judged } from '../test-fixtures'
import { buildScrubMessages, parseScrubOutput, SCRUB_LOG_CONTEXT, SCRUB_MAX_ATTEMPTS, ScrubFailedError, scrubTitle } from './scrub'

const TITLE = 'Ana sagt: der Upload in https://kindred.example/drive bricht bei großen Dateien ab, nervt total'

describe('contribute scrub', () => {
  it('asks for the schema and passes the title only as data', () => {
    const [system, user] = buildScrubMessages(TITLE)
    expect(system.role).toBe('system')
    expect(system.content).toContain('"summary"')
    expect(system.content).toContain('"language"')
    expect(system.content).toContain('"removed"')
    expect(system.content).toContain('English')
    expect(system.content).not.toContain('kindred')
    expect(user.content).toContain(JSON.stringify(TITLE))
  })

  it('parses a valid answer and canonicalises the language tag', () => {
    const out = parseScrubOutput(judged({ summary: '  Drive upload fails for large files.  ', language: 'DE', removed: ['person', 'url', 'other'] }))
    expect(out).toEqual({ summary: 'Drive upload fails for large files.', language: 'de', removed: ['person', 'url', 'other'] })
  })

  it('rejects an empty or too long summary, a bad language tag, an unknown removal kind and extra keys', () => {
    expect(() => parseScrubOutput(judged({ summary: ' ', language: 'en', removed: [] }))).toThrow(/schema/)
    expect(() => parseScrubOutput(judged({ summary: 'x'.repeat(501), language: 'en', removed: [] }))).toThrow(/schema/)
    expect(() => parseScrubOutput(judged({ summary: 'ok', language: 'not a tag!', removed: [] }))).toThrow(/language/)
    expect(() => parseScrubOutput(judged({ summary: 'ok', language: 'en', removed: ['secret-ish'] }))).toThrow(/schema/)
    expect(() => parseScrubOutput(judged({ summary: 'ok', language: 'en', removed: [], title: TITLE }))).toThrow(/schema/)
    expect(() => parseScrubOutput({ choices: [{ message: { content: 'not json' } }] })).toThrow()
  })

  it('goes through the gateway as JSON at temperature 0 with its log context', async () => {
    const calls: Parameters<JudgeChat>[0][] = []
    const out = await scrubTitle(
      async (input) => {
        calls.push(input)
        return judged({ summary: 'Drive upload fails for large files.', language: 'de', removed: ['person'] })
      },
      { userId: 'owner', title: TITLE },
    )
    expect(out.summary).toBe('Drive upload fails for large files.')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ userId: 'owner', temperature: 0, logContext: SCRUB_LOG_CONTEXT, responseFormat: 'json_object' })
    expect(SCRUB_LOG_CONTEXT).toBe('contribute_scrub')
  })

  it('tries exactly 3 times, then fails loud — never returns the raw title', async () => {
    let n = 0
    const bad: JudgeChat = async () => {
      n++
      return judged({ summary: '', language: 'en', removed: [] })
    }
    const err = await scrubTitle(bad, { userId: 'owner', title: TITLE }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ScrubFailedError)
    expect(n).toBe(SCRUB_MAX_ATTEMPTS)
    expect(SCRUB_MAX_ATTEMPTS).toBe(3)
    expect(String((err as Error).message)).not.toContain('kindred')
  })

  it('does not retry a gateway error (no provider, no credits): it surfaces as is', async () => {
    let n = 0
    const failing: JudgeChat = async () => {
      n++
      throw new Error('No AI provider is set up')
    }
    await expect(scrubTitle(failing, { userId: 'owner', title: TITLE })).rejects.toThrow('No AI provider is set up')
    expect(n).toBe(1)
  })
})
