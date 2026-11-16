import { describe, expect, it, vi } from 'vitest'
import { backupKeyHandler } from '$lib/server/fleet/backup-key'

const TOKEN = 'a'.repeat(43)
const KEY = 'K'.repeat(43) + '='
const req = (auth?: string) => new Request('http://127.0.0.1:4000/api/fleet/backup-key', auth ? { headers: { authorization: auth } } : {})
const deps = (created: boolean, managed = true) => ({
  token: managed ? TOKEN : undefined,
  companyKey: vi.fn(async () => ({ backupKey: KEY, recoveryCode: 'EE1-SECRET', created })),
  markPending: vi.fn(async () => {}),
})

describe('GET /api/fleet/backup-key (ee asks os for the backup key, managed mode only)', () => {
  it('is 404 when this box is not managed (no EE_FLEET_LOCAL_TOKEN)', async () => {
    const d = deps(false, false)
    expect((await backupKeyHandler(d)(req(`Bearer ${TOKEN}`))).status).toBe(404)
    expect(d.companyKey).not.toHaveBeenCalled()
  })

  it('is 401 without the bearer token or with a wrong one', async () => {
    const d = deps(false)
    const h = backupKeyHandler(d)
    expect((await h(req())).status).toBe(401)
    expect((await h(req(`Bearer ${'b'.repeat(43)}`))).status).toBe(401)
    expect((await h(req(`Bearer ${TOKEN}x`))).status).toBe(401)
    expect((await h(req(TOKEN))).status).toBe(401)
    expect(d.companyKey).not.toHaveBeenCalled()
  })

  it('answers only the backup key (never the recovery code); an existing root key marks nothing', async () => {
    const d = deps(false)
    const res = await backupKeyHandler(d)(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ backupKey: KEY })
    expect(d.markPending).not.toHaveBeenCalled()
  })

  it('when the call created the root key, the recovery code is marked pending for the owner', async () => {
    const d = deps(true)
    const res = await backupKeyHandler(d)(req(`Bearer ${TOKEN}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ backupKey: KEY })
    expect(d.markPending).toHaveBeenCalledTimes(1)
  })
})
