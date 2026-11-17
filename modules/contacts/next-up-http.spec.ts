import type { ExtractChat } from './extract'
import type { NextUpWiring } from './http'
import { describe, expect, it, vi } from 'vitest'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import { contactsNextUpResponse } from './http'
import { memoryNextUpCache } from './memory-store'
import { createContact } from './service'
import { fixture } from './test-fixtures'

/** GET/POST /api/contacts/next-up over the in-memory store and a gateway double. */

const answer = (json: unknown) => ({ choices: [{ message: { content: JSON.stringify(json) } }] })

function wiringWith(chat: ExtractChat) {
  const f = fixture()
  const cache = memoryNextUpCache()
  const wiring: NextUpWiring = { deps: async () => f.deps, ports: async () => ({ chat, cache }), today: async () => '2026-11-12' }
  return { f, cache, wiring }
}

describe('contacts next-up endpoint', () => {
  it('signed out is a 401', async () => {
    const res = await contactsNextUpResponse(null, { refresh: false }, wiringWith(vi.fn()).wiring)
    expect(res.status).toBe(401)
  })

  it('answers the pick; GET reuses it, POST asks the AI again', async () => {
    const chat = vi.fn<ExtractChat>()
    const { f, wiring } = wiringWith(chat)
    const mara = await createContact(f.deps, { kind: 'user', userId: 'ana' }, { name: 'Mara Voss' })
    chat.mockResolvedValue(answer({ suggestions: [{ contact_id: mara.id, kind: 'write', reason: 'Not contacted yet' }] }))

    const first = await contactsNextUpResponse({ id: 'ana' }, { refresh: false }, wiring)
    expect(first.status).toBe(200)
    const body = (await first.json()) as { nextUp: { generatedAt: string; items: Array<{ contact: { name: string }; kind: string; reason: string }> } }
    expect(body.nextUp.items).toEqual([expect.objectContaining({ kind: 'write', reason: 'Not contacted yet', contact: expect.objectContaining({ name: 'Mara Voss' }) })])
    expect(typeof body.nextUp.generatedAt).toBe('string')

    await contactsNextUpResponse({ id: 'ana' }, { refresh: false }, wiring)
    expect(chat).toHaveBeenCalledTimes(1)
    await contactsNextUpResponse({ id: 'ana' }, { refresh: true }, wiring)
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('no AI provider is a 503 with the plain message; a refusal a 502; a stranger a 403', async () => {
    const none = wiringWith(vi.fn<ExtractChat>().mockRejectedValue(new LlmNotConfiguredError('none')))
    await createContact(none.f.deps, { kind: 'user', userId: 'ana' }, { name: 'Mara Voss' })
    const res = await contactsNextUpResponse({ id: 'ana' }, { refresh: false }, none.wiring)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'unavailable', error: expect.stringContaining('no AI provider') })

    const refused = wiringWith(vi.fn<ExtractChat>().mockRejectedValue(new LlmHttpError(429, 'slow down')))
    await createContact(refused.f.deps, { kind: 'user', userId: 'ana' }, { name: 'Mara Voss' })
    expect((await contactsNextUpResponse({ id: 'ana' }, { refresh: false }, refused.wiring)).status).toBe(502)

    expect((await contactsNextUpResponse({ id: 'stranger' }, { refresh: false }, wiringWith(vi.fn()).wiring)).status).toBe(403)
  })

  it('anything else is a logged 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { wiring } = wiringWith(vi.fn())
    const res = await contactsNextUpResponse({ id: 'ana' }, { refresh: false }, { ...wiring, today: async () => Promise.reject(new Error('tz down')) })
    expect(res.status).toBe(500)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
