import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'owner'),
}))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { EeClient, SubstrateUnavailableError, type EeTransport } from '$lib/server/ee/client'
import { _updatesDeps, actions, load } from './+page.server'
import { GET } from './job/+server'

const NEW = 'eigenenterprise-0.5.17-aaaaaaaaaaaa'
const info = (over: Record<string, unknown> = {}) => ({
  installed: {
    tarball: 'eigenenterprise-0.5.16-14424746613a-linux-arm64.tar.gz',
    version: '0.5.16',
  },
  managed: false,
  source: { kind: 'github', repo: 'hikaru90/eigen-enterprise' },
  job: null,
  ...over,
})
const latest = {
  name: NEW,
  version: '0.5.17',
  notes: '- a change\n',
  from: 'https://github.com/hikaru90/eigen-enterprise/releases/download/v0.5.17',
  state: 'newer',
}
const job = { id: 'job-1', release: NEW, status: 'running', step: 'handover', log: [] }

function ee(
  routes: Record<string, { status: number; data: unknown }>,
  calls: Array<{ m: string; p: string; b: unknown }> = [],
) {
  const t: EeTransport = async (m, p, b) => {
    calls.push({ m, p, b })
    return routes[`${m} ${p}`] ?? { status: 404, data: { detail: `no ${m} ${p}` } }
  }
  _updatesDeps.client = () => new EeClient(t)
  return calls
}
const ev = (user: { id: string } | null = { id: 'u1' }, form?: Record<string, string>) =>
  ({
    locals: { user },
    request: new Request('http://x/settings/updates?/update', {
      method: 'POST',
      body: new URLSearchParams(form ?? {}),
    }),
  }) as never

describe('Settings → Updates (load)', () => {
  beforeEach(() => roleMock.mockResolvedValue('owner'))

  it('shows what runs and the newest signed release with its notes', async () => {
    const calls = ee({
      'GET /v1/upgrade': { status: 200, data: info() },
      'GET /v1/upgrade/latest': { status: 200, data: { latest } },
    })
    expect(await load(ev())).toEqual({
      updates: { onBox: true, ...info(), latest: { ok: true, release: latest } },
    })
    expect(calls.map((c) => `${c.m} ${c.p}`)).toEqual(['GET /v1/upgrade', 'GET /v1/upgrade/latest'])
  })

  it('a failed check (GitHub down, a bad signature) is shown, not hidden', async () => {
    ee({
      'GET /v1/upgrade': { status: 200, data: info() },
      'GET /v1/upgrade/latest': {
        status: 502,
        data: { detail: 'could not check for updates: GET … → 503' },
      },
    })
    expect(await load(ev())).toMatchObject({
      updates: {
        onBox: true,
        latest: {
          ok: false,
          error: 'could not check for updates: GET … → 503',
          agent: { attempted: expect.stringContaining('Checking for a newer') },
        },
      },
    })
  })

  it('a managed box does not look: its hosting provider updates it', async () => {
    const calls = ee({ 'GET /v1/upgrade': { status: 200, data: info({ managed: true }) } })
    expect(await load(ev())).toMatchObject({
      updates: { onBox: true, managed: true, latest: null },
    })
    expect(calls).toHaveLength(1)
  })

  it('an update in progress does not look again (the page shows the update)', async () => {
    const calls = ee({ 'GET /v1/upgrade': { status: 200, data: info({ job }) } })
    expect(await load(ev())).toMatchObject({ updates: { onBox: true, job, latest: null } })
    expect(calls).toHaveLength(1)
  })

  it('not under ee: says so plainly', async () => {
    _updatesDeps.client = () =>
      new EeClient(async () => {
        throw new SubstrateUnavailableError('ENOENT')
      })
    expect(await load(ev())).toMatchObject({
      updates: { onBox: false, reason: expect.stringMatching(/not running under ee/) },
    })
  })

  it('owner and admins only; signed out goes to /login', async () => {
    ee({ 'GET /v1/upgrade': { status: 200, data: info({ managed: true }) } })
    roleMock.mockResolvedValue('admin')
    await expect(load(ev())).resolves.toBeTruthy()
    roleMock.mockResolvedValue('member')
    await expect(load(ev())).rejects.toMatchObject({ status: 403 })
    await expect(load(ev(null))).rejects.toMatchObject({ status: 302, location: '/login' })
  })
})

describe('Settings → Updates (update action)', () => {
  beforeEach(() => roleMock.mockResolvedValue('admin'))

  it('asks ee to install exactly the release shown, as this person', async () => {
    const calls = ee({ 'POST /v1/upgrade': { status: 202, data: { job } } })
    expect(await actions.update(ev({ id: 'u-admin' }, { release: NEW }))).toEqual({
      action: 'update',
      ok: true,
      job,
    })
    expect(calls).toEqual([
      { m: 'POST', p: '/v1/upgrade', b: { release: NEW, author: 'human:u-admin' } },
    ])
  })

  it("ee's refusal is shown next to the button", async () => {
    ee({
      'POST /v1/upgrade': {
        status: 409,
        data: { detail: 'the newest release is now 0.5.18 (…); check again' },
      },
    })
    expect(await actions.update(ev(undefined, { release: NEW }))).toMatchObject({
      status: 409,
      data: {
        action: 'update',
        error: expect.stringMatching(/check again/),
        agent: { input: { release: NEW } },
      },
    })
  })

  it('no release named: refused before ee is asked', async () => {
    const calls = ee({})
    expect(await actions.update(ev(undefined, {}))).toMatchObject({ status: 400 })
    expect(calls).toEqual([])
  })

  it('a member cannot start an update', async () => {
    roleMock.mockResolvedValue('member')
    ee({})
    await expect(actions.update(ev(undefined, { release: NEW }))).rejects.toMatchObject({
      status: 403,
    })
  })
})

describe('GET /settings/updates/job (the page polls it through the restarts)', () => {
  beforeEach(() => roleMock.mockResolvedValue('owner'))

  it("ee's record of the last update", async () => {
    ee({ 'GET /v1/upgrade': { status: 200, data: info({ job }) } })
    const res = await GET(ev())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ job, installed: info().installed })
  })

  it('ee down (the installer restarts it): 503, so the page keeps reconnecting', async () => {
    _updatesDeps.client = () =>
      new EeClient(async () => {
        throw new SubstrateUnavailableError('ECONNREFUSED')
      })
    expect((await GET(ev())).status).toBe(503)
  })

  it('members are refused', async () => {
    roleMock.mockResolvedValue('member')
    await expect(GET(ev())).rejects.toMatchObject({ status: 403 })
  })
})
