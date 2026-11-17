import { describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import type { ExtractChat } from './extract'
import { memoryNextUpCache } from './memory-store'
import { NEXT_UP_LOG_CONTEXT, NEXT_UP_NO_PROVIDER_MESSAGE, buildNextUpMessages, nextUp, parseNextUpOutput } from './next-up'
import { createContact, logContact, pipeline, updateContact } from './service'
import { fixture, user } from './test-fixtures'
import { NEXT_UP_TTL_HOURS } from './types'

const answer = (json: unknown) => ({ choices: [{ message: { content: typeof json === 'string' ? json : JSON.stringify(json) } }] })

/** A gateway double answering from a queue (fails loud when empty). */
function fakeChat(...answers: unknown[]) {
  const queue = [...answers]
  return vi.fn<ExtractChat>(async () => {
    if (queue.length === 0) throw new Error('fake gateway has no answer queued')
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
}

const today = '2026-11-12'

/** Ana's pipeline: two of hers, one shared by Ben, one private to Ben (not hers to write to). */
async function setup() {
  const f = fixture()
  const mara = await createContact(f.deps, user('ana'), { name: 'Mara Voss', channels: [{ type: 'email', value: 'mara@n.example' }] })
  await updateContact(f.deps, user('ana'), mara.id, { stage: 'waiting', waitingSince: '2026-11-01', latestStatus: 'Sent the deck' }, { today })
  const jon = await createContact(f.deps, user('ana'), { name: 'Jon Park', nextFollowUpOn: '2026-11-10', nextStep: 'Send pricing' })
  await updateContact(f.deps, user('ana'), jon.id, { stage: 'next' }, { today })
  const lee = await createContact(f.deps, user('ben'), { name: 'Lee Shared' }, { shared: true })
  const priv = await createContact(f.deps, user('ben'), { name: 'Ben Private' })
  return { f, mara, jon, lee, priv }
}

const pick = (...s: Array<[string, string, string]>) =>
  answer({ suggestions: s.map(([contact_id, kind, reason]) => ({ contact_id, kind, reason })) })

describe('next up: the prompt', () => {
  it('sends the pipeline facts of each candidate and asks for at least min(5, n)', async () => {
    const { f, mara } = await setup()
    const p = await pipeline(f.deps, user('ana'), today)
    const candidates = p.groups.flatMap((g) => g.items)
    const [system, msg] = buildNextUpMessages({ today, userId: 'ana', candidates })
    expect(system.content).toMatch(/Between 3 and 10 suggestions/)
    expect(msg.content).toContain(`Today: ${today}`)
    const facts = JSON.parse(String(msg.content).split('\n').at(-1)!) as Array<Record<string, unknown>>
    expect(facts.find((c) => c.id === mara.id)).toMatchObject({
      list: 'Waiting for a reply',
      waiting_since: '2026-11-01',
      days_waiting: 11,
      latest_status: 'Sent the deck',
      held_by_you: true,
      has_email: true,
    })
  })
})

describe('next up: reading the answer', () => {
  const ids = ['a', 'b', 'c']
  it('keeps valid suggestions in order', () => {
    expect(parseNextUpOutput(pick(['b', 'chase', 'Waited 11 days'], ['a', 'write', 'x'], ['c', 'reply', 'y']), ids)).toEqual([
      { contactId: 'b', kind: 'chase', reason: 'Waited 11 days' },
      { contactId: 'a', kind: 'write', reason: 'x' },
      { contactId: 'c', kind: 'reply', reason: 'y' },
    ])
  })
  it('refuses unknown ids, duplicates, unknown kinds, too few and too long reasons', () => {
    expect(() => parseNextUpOutput(pick(['z', 'write', 'x'], ['a', 'write', 'x'], ['b', 'write', 'x']), ids)).toThrow(/not one of the candidates/)
    expect(() => parseNextUpOutput(pick(['a', 'write', 'x'], ['a', 'write', 'x'], ['b', 'write', 'x']), ids)).toThrow(/twice/)
    expect(() => parseNextUpOutput(pick(['a', 'call', 'x'], ['b', 'write', 'x'], ['c', 'write', 'x']), ids)).toThrow(/schema/)
    expect(() => parseNextUpOutput(pick(['a', 'write', 'x']), ids)).toThrow(/at least 3/)
    expect(() => parseNextUpOutput(pick(['a', 'write', 'x'.repeat(161)], ['b', 'write', 'x'], ['c', 'write', 'x']), ids)).toThrow(/schema/)
  })
})

describe('next up: the pick', () => {
  it('asks the AI over your own and the shared contacts (not other people’s private ones) and keeps the pick', async () => {
    const { f, mara, jon, lee, priv } = await setup()
    const chat = fakeChat(pick([mara.id, 'chase', 'Waited 11 days on the deck'], [jon.id, 'write', 'Pricing is 2 days late'], [lee.id, 'write', 'Not contacted yet']))
    const cache = memoryNextUpCache()
    const out = await nextUp(f.deps, { chat, cache }, user('ana'), { today })
    expect(out.items.map((i) => [i.contact.name, i.kind, i.reason])).toEqual([
      ['Mara Voss', 'chase', 'Waited 11 days on the deck'],
      ['Jon Park', 'write', 'Pricing is 2 days late'],
      ['Lee Shared', 'write', 'Not contacted yet'],
    ])
    expect(chat).toHaveBeenCalledTimes(1)
    const call = chat.mock.calls[0]![0]
    expect(call).toMatchObject({ userId: 'ana', logContext: NEXT_UP_LOG_CONTEXT, responseFormat: 'json_object', temperature: 0 })
    const sent = String(call.messages[1]!.content)
    expect(sent).toContain(mara.id)
    expect(sent).not.toContain(priv.id)
    expect(cache.entries.get('ana')).toMatchObject({ day: today, suggestions: [{ contactId: mara.id }, { contactId: jon.id }, { contactId: lee.id }] })
  })

  it('reuses a fresh pick; after the TTL, on a new day or with refresh it asks again', async () => {
    const { f, mara, jon, lee } = await setup()
    const three = () => pick([mara.id, 'chase', 'r1'], [jon.id, 'write', 'r2'], [lee.id, 'write', 'r3'])
    const chat = fakeChat(three(), three(), three(), three())
    const cache = memoryNextUpCache()
    let t = Date.parse('2026-11-12T10:00:00Z')
    f.deps.now = () => new Date(t)
    const ports = { chat, cache }
    await nextUp(f.deps, ports, user('ana'), { today })
    t += (NEXT_UP_TTL_HOURS * 60 - 1) * 60_000
    await nextUp(f.deps, ports, user('ana'), { today })
    expect(chat).toHaveBeenCalledTimes(1)
    await nextUp(f.deps, ports, user('ana'), { today, refresh: true })
    expect(chat).toHaveBeenCalledTimes(2)
    t += NEXT_UP_TTL_HOURS * 3_600_000
    await nextUp(f.deps, ports, user('ana'), { today })
    expect(chat).toHaveBeenCalledTimes(3)
    await nextUp(f.deps, ports, user('ana'), { today: '2026-11-13' })
    expect(chat).toHaveBeenCalledTimes(4)
  })

  it('drops a contact acted on since the pick (logged) without asking again', async () => {
    const { f, mara, jon, lee } = await setup()
    const chat = fakeChat(pick([mara.id, 'chase', 'r1'], [jon.id, 'write', 'r2'], [lee.id, 'write', 'r3']))
    const ports = { chat, cache: memoryNextUpCache() }
    await nextUp(f.deps, ports, user('ana'), { today })
    await logContact(f.deps, user('ana'), jon.id, { on: today, note: 'Sent it' })
    const out = await nextUp(f.deps, ports, user('ana'), { today })
    expect(out.items.map((i) => i.contact.id)).toEqual([mara.id, lee.id])
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('with nobody to suggest it does not ask the AI', async () => {
    const f = fixture()
    const chat = fakeChat()
    const out = await nextUp(f.deps, { chat, cache: memoryNextUpCache() }, user('ana'), { today })
    expect(out.items).toEqual([])
    expect(chat).not.toHaveBeenCalled()
  })

  it('no AI provider is a plain "unavailable" error and nothing is cached', async () => {
    const { f } = await setup()
    const cache = memoryNextUpCache()
    const chat = fakeChat(new LlmNotConfiguredError('no provider'))
    await expect(nextUp(f.deps, { chat, cache }, user('ana'), { today })).rejects.toMatchObject({
      code: 'unavailable',
      message: NEXT_UP_NO_PROVIDER_MESSAGE,
    })
    expect(cache.entries.size).toBe(0)
  })

  it('an unreadable answer is retried, then fails loud', async () => {
    const { f } = await setup()
    const chat = fakeChat(answer('nope'), answer({ suggestions: [] }), answer({ suggestions: 'x' }))
    await expect(nextUp(f.deps, { chat, cache: memoryNextUpCache() }, user('ana'), { today })).rejects.toMatchObject({ code: 'upstream' })
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('only people in the company', async () => {
    const f = fixture()
    await expect(nextUp(f.deps, { chat: fakeChat(), cache: memoryNextUpCache() }, user('stranger'), { today })).rejects.toMatchObject({
      code: 'forbidden',
    })
  })
})
