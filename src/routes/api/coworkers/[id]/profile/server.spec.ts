import { beforeEach, describe, expect, it } from 'vitest'
import { _coworkerProfileDeps, GET } from './+server'

/** The co-worker profile panel's read (wishes 7c6db153, acdb941e): coworkers.get, plus usage for the owner and admins. */

let calls: { tool: string; input: unknown }[] = []
let role: 'admin' | 'member' = 'admin'
const TOTALS = { costUsd: 0.5, calls: 2, promptTokens: 80, completionTokens: 20, cachedTokens: 0 }

beforeEach(() => {
  calls = []
  role = 'admin'
  _coworkerProfileDeps.role = async () => role
  _coworkerProfileDeps.now = () => new Date('2026-11-28T12:00:00Z')
  _coworkerProfileDeps.run = (async (_u: unknown, tool: string, input: unknown) => {
    calls.push({ tool, input })
    if (tool === 'coworkers.get') return { id: 'cw1', name: 'Mara' }
    return { billing: null, totals: TOTALS, people: [{ userId: 'cw1' }] }
  }) as typeof _coworkerProfileDeps.run
})

const ev = (q = '', user: { id: string } | null = { id: 'u1' }) =>
  ({ locals: { user }, params: { id: 'cw1' }, url: new URL(`http://x/api/coworkers/cw1/profile${q}`) }) as never

describe('GET /api/coworkers/[id]/profile', () => {
  it('an admin gets the co-worker, the edit path and its usage of the period (user_id filtered)', async () => {
    const res = await GET(ev('?usage=7'))
    expect(await res.json()).toEqual({ coworker: { id: 'cw1', name: 'Mara' }, canManage: true, usage: { amounts: TOTALS, billing: null, period: '7' } })
    expect(calls).toEqual([
      { tool: 'coworkers.get', input: { user_id: 'cw1' } },
      { tool: 'settings.ai_usage_overview', input: { from: '2026-11-22', to: '2026-11-28', user_id: 'cw1' } },
    ])
  })

  it('a member reads the profile only: no usage read, no edit path', async () => {
    role = 'member'
    expect(await (await GET(ev())).json()).toEqual({ coworker: { id: 'cw1', name: 'Mara' }, canManage: false, usage: null })
    expect(calls.map((c) => c.tool)).toEqual(['coworkers.get'])
  })

  it('refuses signed-out callers and an unknown period, loudly', async () => {
    await expect(GET(ev('', null))).rejects.toMatchObject({ status: 401 })
    await expect(GET(ev('?usage=week'))).rejects.toMatchObject({ status: 400 })
  })
})
