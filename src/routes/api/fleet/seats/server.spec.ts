import { describe, expect, it, vi } from 'vitest'
import { seatsHandler } from '$lib/server/fleet/seats'

const TOKEN = 'a'.repeat(43)
const req = (auth?: string) => new Request('http://127.0.0.1:4000/api/fleet/seats', auth ? { headers: { authorization: auth } } : {})

describe('GET /api/fleet/seats (ee asks os for billing seats, managed mode only)', () => {
  it('is 404 when this box is not managed (no EE_FLEET_LOCAL_TOKEN)', async () => {
    const count = vi.fn(async () => 3)
    const res = await seatsHandler({ token: undefined, count })(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(404)
    expect(count).not.toHaveBeenCalled()
  })

  it('is 401 without the bearer token or with a wrong one', async () => {
    const count = vi.fn(async () => 3)
    const h = seatsHandler({ token: TOKEN, count })
    expect((await h(req())).status).toBe(401)
    expect((await h(req(`Bearer ${'b'.repeat(43)}`))).status).toBe(401)
    expect((await h(req(`Bearer ${TOKEN}x`))).status).toBe(401)
    expect((await h(req(TOKEN))).status).toBe(401)
    expect(count).not.toHaveBeenCalled()
  })

  it('answers the count of active human members with the right token', async () => {
    const res = await seatsHandler({ token: TOKEN, count: async () => 7 })(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ seats: 7 })
  })
})
