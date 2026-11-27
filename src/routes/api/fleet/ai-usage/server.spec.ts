import { describe, expect, it, vi } from 'vitest'
import { aiUsageHandler, type FleetAiUsageDay } from '$lib/server/fleet/ai-usage'
import { aiUsageDayV1 } from '../../../../../ee/src/fleet/protocol'

const TOKEN = 'a'.repeat(43)
const req = (query: string, auth: string | null = `Bearer ${TOKEN}`) =>
  new Request(`http://127.0.0.1:4000/api/fleet/ai-usage${query}`, auth ? { headers: { authorization: auth } } : {})
const today = () => '2026-11-27'

const row: FleetAiUsageDay = {
  day: '2026-11-26',
  task: 'assistant.turn',
  model: 'deepseek/deepseek-v4-flash',
  calls: 3,
  promptTokens: 1200,
  completionTokens: 300,
  cachedTokens: 800,
  costUsd: 0.0042,
}

describe('GET /api/fleet/ai-usage (ee reads the eigenInference usage per day × task × model, managed mode only)', () => {
  it('is 404 off a managed box and 401 with a wrong token; nothing read', async () => {
    const read = vi.fn(async () => [row])
    expect((await aiUsageHandler({ token: undefined, today, read })(req('?from=2026-11-01'))).status).toBe(404)
    expect((await aiUsageHandler({ token: TOKEN, today, read })(req('?from=2026-11-01', null))).status).toBe(401)
    expect((await aiUsageHandler({ token: TOKEN, today, read })(req('?from=2026-11-01', `Bearer ${'b'.repeat(43)}`))).status).toBe(401)
    expect(read).not.toHaveBeenCalled()
  })

  it('answers the rows from the given UTC day, each one a valid fleet aiUsageDayV1', async () => {
    const read = vi.fn(async () => [row, { ...row, task: null, model: null }])
    const res = await aiUsageHandler({ token: TOKEN, today, read })(req('?from=2026-11-01'))
    expect(res.status).toBe(200)
    expect(read).toHaveBeenCalledWith('2026-11-01')
    const body = (await res.json()) as { rows: unknown[] }
    expect(body.rows).toHaveLength(2)
    for (const r of body.rows) expect(aiUsageDayV1.parse(r)).toEqual(r)
  })

  it('today itself is a valid from', async () => {
    const read = vi.fn(async () => [])
    const res = await aiUsageHandler({ token: TOKEN, today, read })(req('?from=2026-11-27'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [] })
  })

  it('a missing, malformed or future from is a 400 naming why; nothing read', async () => {
    const read = vi.fn(async () => [row])
    const h = aiUsageHandler({ token: TOKEN, today, read })
    for (const q of ['', '?from=', '?from=2026-13-01', '?from=27.11.2026', '?from=2026-11-28']) {
      const res = await h(req(q))
      expect(res.status, q).toBe(400)
      expect(await res.text()).toMatch(/from/)
    }
    expect(read).not.toHaveBeenCalled()
  })
})
