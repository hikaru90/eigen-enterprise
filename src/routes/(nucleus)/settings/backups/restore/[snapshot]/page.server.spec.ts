import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (): Promise<string | null> => 'owner') }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { EeClient, SubstrateUnavailableError, type EeTransport } from '$lib/server/ee/client'
import { CompanyKeyError } from '$lib/server/gitstore/keys'
import { _backupsDeps } from '../../+page.server'
import { actions, load } from './+page.server'

const SNAP = '20261101T031700Z'
const CODE = 'EE1-AAAAA-BBBBB-CCCCC'
const KEY = 'K'.repeat(43) + '='
const status = { configured: true, target: null, schedule: null, retentionDays: null, configuredAt: null, keyCreatedAt: null, health: { state: 'ok', lastSuccessAt: 't' }, runs: [] }
const job = { id: 'job-1', kind: 'restore', snapshotId: SNAP, author: 'human:u-owner', status: 'running', step: 'verifying', startedAt: 't', updatedAt: 't', endedAt: null, checked: null, error: null, log: [], announced: false }

function wire(answers: Record<string, { status: number; data: unknown }>, name: string | null = 'Acme GmbH') {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    const a = answers[`${method} ${path}`]
    if (!a) throw new Error(`unexpected ${method} ${path}`)
    return a
  }
  const codes: string[] = []
  _backupsDeps.client = () => new EeClient(transport)
  _backupsDeps.companyName = async () => name
  _backupsDeps.backupKeyFromCode = async (code) => {
    codes.push(code)
    if (code !== CODE) throw new CompanyKeyError('the recovery code has a typo (checksum mismatch)')
    return KEY
  }
  return { calls, codes }
}

const ev = (form?: Record<string, string>, snapshot = SNAP) =>
  ({
    locals: { user: { id: 'u-owner' } },
    params: { snapshot },
    request: new Request(`http://x/settings/backups/restore/${snapshot}`, { method: 'POST', body: new URLSearchParams(form ?? {}) }),
  }) as never

const good = { confirmName: 'Acme GmbH', recoveryCode: CODE }

describe('Settings → Backups → Restore (owner only, D11; ee restores, the console only asks)', () => {
  beforeEach(() => roleMock.mockResolvedValue('owner'))

  it.each(['admin', 'member'])('a %s gets 403 — page and action, ee never asked', async (role) => {
    roleMock.mockResolvedValue(role)
    const { calls } = wire({})
    await expect(load(ev() as never)).rejects.toMatchObject({ status: 403 })
    await expect(actions.restore!(ev(good))).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  it('load: the backup, the company name to type, and the last job (progress survives a reload)', async () => {
    wire({ 'GET /v1/backups': { status: 200, data: status }, 'GET /v1/backups/restore': { status: 200, data: { job } } })
    expect(await load(ev() as never)).toEqual({
      restore: { managed: true, configured: true, snapshotId: SNAP, takenAt: '2026-11-01T03:17:00.000Z', companyName: 'Acme GmbH', job },
    })
  })

  it('load: a malformed snapshot id is a 404; off an ee box the plain not-managed state', async () => {
    wire({})
    await expect(load(ev(undefined, '..%2Fetc') as never)).rejects.toMatchObject({ status: 404 })
    _backupsDeps.client = () =>
      new EeClient(async () => {
        throw new SubstrateUnavailableError('ENOENT')
      })
    expect(await load(ev() as never)).toMatchObject({ restore: { managed: false } })
  })

  it('restore: typed company name + recovery code → ee gets the snapshot and the DERIVED key, never the code', async () => {
    const { calls } = wire({ 'POST /v1/backups/restore': { status: 202, data: { job } } })
    expect(await actions.restore!(ev(good))).toEqual({ action: 'restore', ok: true, job })
    expect(calls).toEqual([{ method: 'POST', path: '/v1/backups/restore', body: { snapshotId: SNAP, backupKey: KEY, author: 'human:u-owner' } }])
    expect(JSON.stringify(calls)).not.toContain(CODE)
  })

  it('refused before ee: wrong or missing company name, no name at all, missing or mistyped code — and the code is never echoed', async () => {
    const { calls } = wire({})
    const wrong = await actions.restore!(ev({ ...good, confirmName: 'acme' }))
    expect(wrong).toMatchObject({ status: 400, data: { error: expect.stringMatching(/exactly as shown \(Acme GmbH\)/) } })
    expect(await actions.restore!(ev({ ...good, recoveryCode: '' }))).toMatchObject({ status: 400, data: { error: expect.stringMatching(/recovery code/) } })
    const typo = await actions.restore!(ev({ ...good, recoveryCode: 'EE1-AAAAA-BBBBB-CCCCD' }))
    expect(typo).toMatchObject({ status: 400, data: { error: expect.stringMatching(/not right.*typo/) } })
    expect(JSON.stringify(typo)).not.toContain('EE1-AAAAA')
    wire({}, null)
    expect(await actions.restore!(ev(good))).toMatchObject({ status: 409, data: { error: expect.stringMatching(/Settings → Company/) } })
    expect(calls).toEqual([])
  })

  it("ee's refusals show plainly: another company's code, a backup or restore already running", async () => {
    wire({ 'POST /v1/backups/restore': { status: 422, data: { detail: "this recovery code does not open this company's backups" } } })
    expect(await actions.restore!(ev(good))).toMatchObject({ status: 422, data: { action: 'restore', error: expect.stringMatching(/does not open/) } })
    wire({ 'POST /v1/backups/restore': { status: 409, data: { detail: 'a backup is running; wait for it to finish' } } })
    expect(await actions.restore!(ev(good))).toMatchObject({ status: 409, data: { error: expect.stringMatching(/backup is running/) } })
  })
})
