import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { EXTRACT_MAX_ATTEMPTS } from '../../../../../modules/contacts/extract'
import { createContact } from '../../../../../modules/contacts/service'
import { fixture, user } from '../../../../../modules/contacts/test-fixtures'
import { POST } from './+server'

/** The gateway is faked; everything between the request and it is real (fixture store). */
const m = vi.hoisted(() => ({
  llmChatCompletion: vi.fn(),
  onCompanyProvider: vi.fn(),
  deps: null as unknown,
}))

vi.mock('$lib/server/llm/llm-client', () => ({ llmChatCompletion: m.llmChatCompletion }))
vi.mock('$lib/server/llm/company-provider', () => ({ onCompanyProvider: m.onCompanyProvider }))
vi.mock('../../../../../modules/contacts/live', () => ({
  contactsDeps: async () => m.deps,
  todayFor: async () => '2026-11-12',
}))

const answer = (json: unknown) => ({ choices: [{ message: { content: JSON.stringify(json) } }] })

const said = {
  name: 'Mara Voss',
  organisation: 'Northwind Capital',
  title: null,
  channels: [{ type: 'email', value: 'mara@northwind.example' }],
  met_how: 'Founders breakfast',
  why_relevant: null,
  tags: ['investor', 'press'],
  last_contacted_on: null,
  next_follow_up_on: '2026-11-19',
  next_step: 'Send the deck',
}

const call = (body: unknown, who: { id: string } | null = { id: 'ana' }) =>
  POST({
    locals: { user: who },
    request: new Request('http://os.test/api/contacts/extract', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  } as never)

describe('POST /api/contacts/extract', () => {
  let f: ReturnType<typeof fixture>

  beforeEach(async () => {
    m.llmChatCompletion.mockReset()
    m.onCompanyProvider.mockReset()
    m.onCompanyProvider.mockImplementation((fn: () => Promise<unknown>) => fn())
    f = fixture()
    m.deps = f.deps
    // a tag in use on a contact Ana sees: offered beside the default ones
    await createContact(f.deps, user('ana'), { name: 'Pia Press', tags: ['press'] })
  })

  it('401s signed-out visitors before any model call', async () => {
    const res = await call({ mode: 'contact', text: 'Mara' }, null)
    expect(res.status).toBe(401)
    expect(m.llmChatCompletion).not.toHaveBeenCalled()
  })

  it('a schema-valid answer comes back as the prefill draft — and nothing is saved', async () => {
    m.llmChatCompletion.mockResolvedValue(answer(said))
    const before = (await f.store.list({ kind: 'all' }, {})).length
    const res = await call({ mode: 'contact', text: 'Mara Voss from Northwind, mara@northwind.example, an investor' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      draft: {
        name: 'Mara Voss',
        organisation: 'Northwind Capital',
        title: null,
        channels: [{ type: 'email', value: 'mara@northwind.example' }],
        metHow: 'Founders breakfast',
        whyRelevant: null,
        tags: ['investor', 'press'],
        lastContactedOn: null,
        nextFollowUpOn: '2026-11-19',
        nextStep: 'Send the deck',
      },
    })
    // on the company's AI provider, attributed to Ana; the offered tags and her today in the prompt
    expect(m.onCompanyProvider).toHaveBeenCalledTimes(1)
    const input = m.llmChatCompletion.mock.calls[0]![0] as { userId: string; messages: Array<{ content: string }> }
    expect(input.userId).toBe('ana')
    expect(input.messages[1]!.content).toContain('Today: 2026-11-12')
    expect(input.messages[1]!.content).toContain('"press"')
    expect((await f.store.list({ kind: 'all' }, {})).length).toBe(before)
  })

  it('reads "Log a contact" too', async () => {
    m.llmChatCompletion.mockResolvedValue(answer({ in_touch_on: '2026-11-11', how_it_went: 'Short call', next_follow_up_on: null, next_step: null }))
    const res = await call({ mode: 'log', text: 'We spoke yesterday, nothing next' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ draft: { on: '2026-11-11', note: 'Short call', nextFollowUpOn: null, nextStep: null } })
  })

  it(`an invalid answer is retried, then a plain 502 after ${EXTRACT_MAX_ATTEMPTS} tries`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.llmChatCompletion.mockResolvedValue(answer({ ...said, tags: ['astronaut'] }))
    const res = await call({ mode: 'contact', text: 'Mara, an astronaut' })
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ code: 'upstream', error: expect.stringContaining('couldn’t be read') })
    expect(m.llmChatCompletion).toHaveBeenCalledTimes(EXTRACT_MAX_ATTEMPTS)
  })

  it('an invalid answer then a valid one is a 200', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    m.llmChatCompletion.mockResolvedValueOnce(answer({ name: 'Mara' })).mockResolvedValueOnce(answer(said))
    const res = await call({ mode: 'contact', text: 'Mara' })
    expect(res.status).toBe(200)
    expect(m.llmChatCompletion).toHaveBeenCalledTimes(2)
  })

  it('no company AI provider is a 503 with a plain sentence', async () => {
    m.onCompanyProvider.mockRejectedValue(new LlmNotConfiguredError('no owner'))
    const res = await call({ mode: 'contact', text: 'Mara' })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'unavailable', error: expect.stringContaining('Settings → AI provider') })
  })

  it.each([
    ['an unknown mode', { mode: 'poem', text: 'Mara' }],
    ['no text', { mode: 'contact', text: '  ' }],
    ['a body that is not JSON', 'mara'],
  ])('400s %s', async (_label, body) => {
    const res = await call(body)
    expect(res.status).toBe(400)
    expect(m.llmChatCompletion).not.toHaveBeenCalled()
  })

  it('403s someone who is not in the company', async () => {
    const res = await call({ mode: 'contact', text: 'Mara' }, { id: 'stranger' })
    expect(res.status).toBe(403)
    expect(m.llmChatCompletion).not.toHaveBeenCalled()
  })
})
