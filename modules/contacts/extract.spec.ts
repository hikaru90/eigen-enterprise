import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import { ContactsError } from './errors'
import {
  EXTRACT_LOG_CONTEXT,
  EXTRACT_MAX_ATTEMPTS,
  buildContactExtractMessages,
  extractContactDraft,
  extractLogDraft,
  parseContactExtractOutput,
  parseLogExtractOutput,
  type ExtractChat,
} from './extract'
import { DEFAULT_TAGS } from './types'

const answer = (json: unknown) => ({ choices: [{ message: { content: typeof json === 'string' ? json : JSON.stringify(json) } }] })

/** A gateway double answering from a queue (fails loud when empty). */
function fakeChat(...answers: unknown[]) {
  const queue = [...answers]
  const chat = vi.fn<ExtractChat>(async () => {
    if (queue.length === 0) throw new Error('fake gateway has no answer queued')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
  return chat
}

const tags = [...DEFAULT_TAGS, 'press']
const today = '2026-11-12'

const full = {
  name: 'Mara Voss',
  organisation: 'Northwind Capital',
  title: 'Partner',
  channels: [
    { type: 'email', value: 'mara@northwind.example' },
    { type: 'phone', value: '+49 30 1234567' },
  ],
  met_how: 'Founders breakfast in Berlin, introduced by Ana',
  why_relevant: 'Leads seed rounds in climate tech',
  tags: ['investor', 'Press'],
  last_contacted_on: '2026-11-10',
  next_follow_up_on: '2026-11-19',
  next_step: 'Send her the deck',
}

const none = {
  name: null,
  organisation: null,
  title: null,
  channels: [],
  met_how: null,
  why_relevant: null,
  tags: [],
  last_contacted_on: null,
  next_follow_up_on: null,
  next_step: null,
}

afterEach(() => vi.restoreAllMocks())

describe('contact extraction: the prompt', () => {
  it('gives the model today, the offered tags, the channel types and the schema; the description goes in as data', () => {
    const [system, user] = buildContactExtractMessages({ text: 'Met Mara at the breakfast', today, tags })
    expect(system!.role).toBe('system')
    expect(system!.content).toContain('"next_follow_up_on"')
    expect(system!.content).toContain('email, phone, linkedin, website, other')
    expect(user!.content).toContain(`Today: ${today}`)
    for (const tag of tags) expect(user!.content).toContain(JSON.stringify(tag))
    expect(user!.content).toContain(JSON.stringify('Met Mara at the breakfast'))
  })
})

describe('contact extraction: validating the answer', () => {
  it('a schema-valid answer becomes the prefill draft (tags as the form stores them)', () => {
    expect(parseContactExtractOutput(answer(full), { tags, today })).toEqual({
      name: 'Mara Voss',
      organisation: 'Northwind Capital',
      title: 'Partner',
      channels: [
        { type: 'email', value: 'mara@northwind.example' },
        { type: 'phone', value: '+49 30 1234567' },
      ],
      metHow: 'Founders breakfast in Berlin, introduced by Ana',
      whyRelevant: 'Leads seed rounds in climate tech',
      tags: ['investor', 'press'],
      lastContactedOn: '2026-11-10',
      nextFollowUpOn: '2026-11-19',
      nextStep: 'Send her the deck',
    })
  })

  it('what was not said stays empty (null or an empty string)', () => {
    expect(parseContactExtractOutput(answer({ ...none, name: 'Mara', organisation: '' }), { tags, today })).toEqual({
      name: 'Mara',
      organisation: null,
      title: null,
      channels: [],
      metHow: null,
      whyRelevant: null,
      tags: [],
      lastContactedOn: null,
      nextFollowUpOn: null,
      nextStep: null,
    })
  })

  it.each([
    ['a tag the form does not offer', { ...full, tags: ['astronaut'] }],
    ['an unknown channel type', { ...full, channels: [{ type: 'fax', value: '123' }] }],
    ['a date that is not a day', { ...full, next_follow_up_on: 'next Tuesday' }],
    ['an impossible day', { ...full, next_follow_up_on: '2026-02-30' }],
    ['last in touch after today', { ...full, last_contacted_on: '2026-11-13' }],
    ['a missing field', { name: 'Mara' }],
    ['an extra field', { ...full, mood: 'happy' }],
    ['a name longer than a contact takes', { ...full, name: 'x'.repeat(201) }],
    ['a channel without a value', { ...full, channels: [{ type: 'email', value: ' ' }] }],
  ])('refuses %s', (_label, json) => {
    expect(() => parseContactExtractOutput(answer(json), { tags, today })).toThrow()
  })

  it('refuses an answer that is not JSON', () => {
    expect(() => parseContactExtractOutput(answer('Sure! Mara is an investor.'), { tags, today })).toThrow()
  })
})

describe('extractContactDraft', () => {
  const input = { userId: 'ana', text: 'Mara Voss, partner at Northwind, mara@northwind.example', today, tags }

  it('asks the gateway once in JSON mode, cost-tracked under its own context', async () => {
    const chat = fakeChat(answer(full))
    const draft = await extractContactDraft(chat, input)
    expect(draft.name).toBe('Mara Voss')
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0]![0]).toMatchObject({
      userId: 'ana',
      temperature: 0,
      logContext: EXTRACT_LOG_CONTEXT,
      responseFormat: 'json_object',
    })
  })

  it('an invalid answer is retried; a valid one then wins', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chat = fakeChat(answer({ ...full, tags: ['astronaut'] }), answer(full))
    expect((await extractContactDraft(chat, input)).tags).toEqual(['investor', 'press'])
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it(`after ${EXTRACT_MAX_ATTEMPTS} unreadable answers it fails loud — never a guessed draft`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chat = fakeChat(...Array.from({ length: EXTRACT_MAX_ATTEMPTS }, () => answer('not json')))
    const err = await extractContactDraft(chat, input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ContactsError)
    expect(err).toMatchObject({ code: 'upstream' })
    expect(chat).toHaveBeenCalledTimes(EXTRACT_MAX_ATTEMPTS)
  })

  it('no company AI provider is a plain "unavailable", not retried', async () => {
    const chat = fakeChat(new LlmNotConfiguredError('no provider'))
    await expect(extractContactDraft(chat, input)).rejects.toMatchObject({ code: 'unavailable' })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('the provider refusing is "upstream", not retried', async () => {
    const chat = fakeChat(new LlmHttpError(429, 'slow down'))
    await expect(extractContactDraft(chat, input)).rejects.toMatchObject({ code: 'upstream' })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('refuses an empty or overlong description before any model call', async () => {
    const chat = fakeChat()
    await expect(extractContactDraft(chat, { ...input, text: '   ' })).rejects.toMatchObject({ code: 'invalid' })
    await expect(extractContactDraft(chat, { ...input, text: 'x'.repeat(8001) })).rejects.toMatchObject({ code: 'invalid' })
    expect(chat).not.toHaveBeenCalled()
  })
})

describe('extractLogDraft ("Log a contact")', () => {
  const input = { userId: 'ana', text: 'Spoke yesterday, I send the deck next Thursday', today }

  it('reads the day you were in touch, how it went and what comes next', async () => {
    const chat = fakeChat(
      answer({ in_touch_on: '2026-11-11', how_it_went: 'She liked the plan', next_follow_up_on: '2026-11-19', next_step: 'Send the deck' }),
    )
    expect(await extractLogDraft(chat, input)).toEqual({
      on: '2026-11-11',
      note: 'She liked the plan',
      nextFollowUpOn: '2026-11-19',
      nextStep: 'Send the deck',
    })
  })

  it('how it went is part of the schema: an answer without it is not read', () => {
    expect(() =>
      parseLogExtractOutput(answer({ in_touch_on: '2026-11-11', next_follow_up_on: null, next_step: null }), { today }),
    ).toThrow(/how_it_went/)
  })

  it('refuses an in-touch day after today', () => {
    expect(() =>
      parseLogExtractOutput(answer({ in_touch_on: '2026-11-13', how_it_went: null, next_follow_up_on: null, next_step: null }), { today }),
    ).toThrow()
  })

  it('retries an invalid answer, then fails loud', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chat = fakeChat(...Array.from({ length: EXTRACT_MAX_ATTEMPTS }, () => answer({ in_touch_on: 'soon' })))
    await expect(extractLogDraft(chat, input)).rejects.toMatchObject({ code: 'upstream' })
    expect(chat).toHaveBeenCalledTimes(EXTRACT_MAX_ATTEMPTS)
  })
})
