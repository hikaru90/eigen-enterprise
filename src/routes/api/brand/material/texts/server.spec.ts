import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { InMemoryBrandStore } from '../../../../../../modules/brand/store'

/** The texts endpoint over the real suggest path with a scripted gateway. */

const { gateway, state } = vi.hoisted(() => ({ gateway: vi.fn(), state: { brand: null as unknown } }))

vi.mock('$lib/server/llm/llm-client', () => ({ llmChatCompletion: gateway }))
vi.mock('$lib/server/llm/company-provider', () => ({ onCompanyProvider: (run: () => unknown) => run() }))
vi.mock('../../../../../../modules/brand/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  defaultBrandStore: () => state.brand,
}))

const { POST } = await import('./+server')

const call = (body: unknown, user: { id: string } | null = { id: 'ana' }) =>
  POST({
    locals: { user },
    request: new Request('http://x/', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  } as never)

const variants = [1, 2, 3].map((n) => ({ headline: `H${n}`, body: `B${n}`, cta: `C${n}` }))

describe('POST /api/brand/material/texts', () => {
  beforeEach(() => {
    gateway.mockReset()
    state.brand = new InMemoryBrandStore()
  })

  it('returns three variants from one gateway call, as the person', async () => {
    gateway.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ variants }) } }] })
    const res = await call({ formatId: 'flyer-a5', brief: 'Open day on 3 May' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ formatId: 'flyer-a5', locale: null, voice: false, variants })
    expect(gateway.mock.calls[0][0]).toMatchObject({ userId: 'ana', logContext: 'brand_material_texts', responseFormat: 'json_object' })
  })

  it('no AI provider → 503 with the plain sentence and an agent report', async () => {
    gateway.mockRejectedValueOnce(new LlmNotConfiguredError('none'))
    const res = await call({ formatId: 'flyer-a5' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { message: string; agent: { attempted: string } }
    expect(body.message).toMatch(/no AI provider set up yet/)
    expect(body.agent.attempted).toBe('Writing texts for brand material (Brand › Material)')
  })

  it('an unknown field or format → 400, no gateway call; signed out → 401', async () => {
    expect((await call({ formatId: 'flyer-a5', tone: 'loud' })).status).toBe(400)
    expect((await call({ formatId: 'billboard' })).status).toBe(400)
    expect(gateway).not.toHaveBeenCalled()
    await expect(call({ formatId: 'flyer-a5' }, null)).rejects.toMatchObject({ status: 401 })
  })
})
