import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (): Promise<string | null> => 'owner') }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { EeClient, SubstrateUnavailableError } from '$lib/server/ee/client'
import { _backupsDeps } from '../+page.server'
import { GET } from './+server'

const ev = (user: { id: string } | null = { id: 'u-owner' }) => ({ locals: { user } }) as never
const job = { id: 'job-1', kind: 'restore', snapshotId: '20261101T031700Z', status: 'running', step: 'restoring-database' }

describe('GET /settings/backups/job (the restore screen polls it)', () => {
  beforeEach(() => roleMock.mockResolvedValue('owner'))

  it('owner: ee\'s record of the last check/restore', async () => {
    _backupsDeps.client = () => new EeClient(async (m, p) => (m === 'GET' && p === '/v1/backups/restore' ? { status: 200, data: { job } } : { status: 404, data: null }))
    const res = await GET(ev())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ job })
  })

  it('ee down (mid-restore): 503, so the page keeps reconnecting', async () => {
    _backupsDeps.client = () =>
      new EeClient(async () => {
        throw new SubstrateUnavailableError('ECONNREFUSED')
      })
    const res = await GET(ev())
    expect(res.status).toBe(503)
  })

  it('not the owner: 403; signed out: to /login (the page tells them to sign in again)', async () => {
    roleMock.mockResolvedValue('admin')
    await expect(GET(ev())).rejects.toMatchObject({ status: 403 })
    await expect(GET(ev(null))).rejects.toMatchObject({ status: 302, location: '/login' })
  })
})
