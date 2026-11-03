import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (): Promise<string | null> => 'owner') }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { EeClient, SubstrateUnavailableError, type EeTransport } from '$lib/server/ee/client'
import { actions, _backupsDeps, load } from './+page.server'

const status = { configured: false, target: null, schedule: null, retentionDays: null, configuredAt: null, keyCreatedAt: null, health: { state: 'unconfigured' }, runs: [] }

function wire(answers: Record<string, { status: number; data: unknown }>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const transport: EeTransport = async (method, path, body) => {
    calls.push({ method, path, body })
    const a = answers[`${method} ${path}`]
    if (!a) throw new Error(`unexpected ${method} ${path}`)
    return a
  }
  _backupsDeps.client = () => new EeClient(transport)
  return calls
}

const user = { id: 'u-owner' }
const ev = (form?: Record<string, string>) =>
  ({
    locals: { user },
    request: new Request('http://x/settings/backups', { method: 'POST', body: new URLSearchParams(form ?? {}) }),
  }) as never

const fields = {
  endpoint: 'http://127.0.0.1:9311',
  region: 'us-east-1',
  bucket: 'acme-backups',
  prefix: '/nightly/',
  addressing: 'path',
  accessKeyId: 'AK',
  secretAccessKey: 'SK',
  hour: '2',
  retentionDays: '30',
}

describe('Settings → Backups (owner only, D11)', () => {
  beforeEach(() => roleMock.mockResolvedValue('owner'))

  it.each(['admin', 'member'])('a %s gets 403 — page and every action', async (role) => {
    roleMock.mockResolvedValue(role)
    const calls = wire({})
    await expect(load(ev() as never)).rejects.toMatchObject({ status: 403 })
    await expect(actions.save!(ev(fields))).rejects.toMatchObject({ status: 403 })
    await expect(actions.run!(ev())).rejects.toMatchObject({ status: 403 })
    await expect(actions.test!(ev(fields))).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  it('load: ee status, or the plain not-managed state off an ee box', async () => {
    wire({ 'GET /v1/backups': { status: 200, data: status } })
    expect(await load(ev() as never)).toEqual({ backups: { managed: true, status } })
    _backupsDeps.client = () =>
      new EeClient(async () => {
        throw new SubstrateUnavailableError('ENOENT')
      })
    expect(await load(ev() as never)).toMatchObject({ backups: { managed: false } })
  })

  it('test connection: sends the target (prefix trimmed), surfaces the plain failure', async () => {
    const calls = wire({ 'POST /v1/backups/test': { status: 200, data: { ok: false, error: 'S3 PUT failed: 403 InvalidAccessKeyId' } } })
    const r = await actions.test!(ev(fields))
    expect(r).toMatchObject({ status: 400, data: { action: 'test', error: 'Connection failed: S3 PUT failed: 403 InvalidAccessKeyId' } })
    expect(calls[0]!.body).toEqual({
      target: { endpoint: 'http://127.0.0.1:9311', region: 'us-east-1', bucket: 'acme-backups', prefix: 'nightly', addressing: 'path', accessKeyId: 'AK', secretAccessKey: 'SK' },
    })
  })

  it('save: the owner is the author; the recovery code comes back in this response only', async () => {
    const calls = wire({ 'POST /v1/backups/config': { status: 200, data: { recoveryCode: 'ABCDEF-…', config: status } } })
    expect(await actions.save!(ev(fields))).toEqual({ action: 'save', ok: true, recoveryCode: 'ABCDEF-…' })
    expect(calls[0]!.body).toMatchObject({ schedule: { hour: 2 }, retentionDays: 30, author: 'human:u-owner' })
  })

  it('save: an empty secret is left out (ee keeps the saved one); bad numbers are refused before ee', async () => {
    const calls = wire({ 'POST /v1/backups/config': { status: 200, data: { recoveryCode: null, config: status } } })
    await actions.save!(ev({ ...fields, secretAccessKey: '' }))
    expect((calls[0]!.body as { target: object }).target).not.toHaveProperty('secretAccessKey')
    expect(await actions.save!(ev({ ...fields, retentionDays: '0' }))).toMatchObject({ status: 400, data: { error: expect.stringMatching(/Keep backups for/) } })
    expect(calls).toHaveLength(1)
  })

  it('a refused save shows ee\'s reason', async () => {
    wire({ 'POST /v1/backups/config': { status: 422, data: { detail: 'connection test failed, nothing saved: S3 PUT failed: 404 NoSuchBucket' } } })
    expect(await actions.save!(ev(fields))).toMatchObject({ status: 422, data: { error: expect.stringMatching(/NoSuchBucket/) } })
  })

  it('back up now: a manual run authored by the owner', async () => {
    const calls = wire({ 'POST /v1/backups/run': { status: 200, data: { run: { id: 'run-1' } } } })
    expect(await actions.run!(ev())).toEqual({ action: 'run', ok: true, runId: 'run-1' })
    expect(calls[0]!.body).toEqual({ author: 'human:u-owner', trigger: 'manual', wait: false })
  })
})
