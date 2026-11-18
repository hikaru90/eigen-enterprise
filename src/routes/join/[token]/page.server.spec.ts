import { describe, expect, it } from 'vitest'
import { fixture } from '../../../../modules/calls/test-fixtures'
import { _deps, load } from './+page.server'

/** The guest page's load (proposal 844bab56): every link state, the call only while the link works. */

const min = (n: number) => n * 60_000
const tokenOf = (url: string) => decodeURIComponent(url.split('/join/')[1]!)

async function setup(input: Record<string, unknown> = {}) {
  const f = fixture()
  _deps.service = async () => f.service
  const startsAt = new Date(f.clock.now().getTime() + min(60))
  const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org'], startsAt, durationMinutes: 30, title: 'Kick-off', timeZone: 'UTC', ...input })
  return { f, out, token: tokenOf(out.invitations[0]!.url) }
}

const run = async (token: string) => {
  const headers: Record<string, string> = {}
  const data = (await load({ params: { token }, setHeaders: (h: Record<string, string>) => Object.assign(headers, h) } as never)) as {
    view: { status: string } | null
    call: { id: string } | null
  }
  return { data, headers }
}

describe('/join/[token] load', () => {
  it('unknown link: no view, no call; never cached, no referrer', async () => {
    await setup()
    const { data, headers } = await run('x'.repeat(43))
    expect(data).toMatchObject({ view: null, call: null })
    expect(headers).toMatchObject({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  })

  it('too early → expired over time; the call only inside the window', async () => {
    const { f, token, out } = await setup()
    expect((await run(token)).data).toMatchObject({ view: { status: 'too_early' }, call: null })
    f.clock.tick(min(45))
    expect((await run(token)).data).toMatchObject({ view: { status: 'ok' }, call: { id: out.call.id } })
    f.clock.tick(min(60))
    expect((await run(token)).data).toMatchObject({ view: { status: 'expired' }, call: null })
  })

  it('withdrawn and over', async () => {
    const { f, token, out } = await setup()
    await f.service.revokeGuest('ann', out.call.id, out.call.guests[0]!.id)
    expect((await run(token)).data.view?.status).toBe('revoked')
    const other = await setup()
    await other.f.service.end(other.f.user('ann'), other.out.call.id)
    expect((await run(other.token)).data.view?.status).toBe('over')
  })

})
