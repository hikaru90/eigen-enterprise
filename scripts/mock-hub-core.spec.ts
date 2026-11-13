import { describe, expect, it } from 'vitest'
import { HUB_PATHS, signHubRequest } from '../modules/contribute/share/contract'
import { generateInstallKey } from '../modules/contribute/share/identity'
import { createMockHub } from './mock-hub-core'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const REMOTE = '6f1c8e0a-1b2c-4d3e-8f40-5a6b7c8d9e0f'

const payload = {
  v: 1,
  remote_id: REMOTE,
  summary: 'Keep replies in threads',
  language: 'en',
  kind: 'bug',
  area: 'messages',
  status: 'requested',
  score: 1,
  app_version: '0.5.9',
  created_day: '2026-11-13',
  shipped_day: null,
}

function setup() {
  const hub = createMockHub(() => NOW)
  const key = generateInstallKey()
  const reg = JSON.stringify({ v: 1, install_id: key.installId, public_key: key.publicKey, app_version: '0.5.9' })
  const signed = (method: string, path: string, body: string, privateKey = key.privateKey) =>
    hub.receive(method, path, signHubRequest({ method, path, body, installId: key.installId, privateKey, now: NOW }), body)
  return { hub, key, reg, signed }
}

describe('mock hub (contract-checked, signature-verified)', () => {
  it('registers, then accepts a signed PUT of exactly the contract and records both', () => {
    const { hub, reg, signed } = setup()
    expect(hub.receive('POST', HUB_PATHS.register, {}, reg).status).toBe(201)
    expect(signed('PUT', HUB_PATHS.contribution(REMOTE), JSON.stringify(payload)).status).toBe(201)
    expect(signed('PUT', HUB_PATHS.contribution(REMOTE), JSON.stringify({ ...payload, score: 2 })).status).toBe(200)
    expect(hub.requests.map((r) => [r.method, r.status, r.signatureOk])).toEqual([
      ['POST', 201, null],
      ['PUT', 201, true],
      ['PUT', 200, true],
    ])
    expect(JSON.parse(hub.requests[1].body)).toEqual(payload)
  })

  it('refuses an unregistered install, a signature by another key, and an extra key in the body', () => {
    const { hub, reg, signed } = setup()
    expect(signed('PUT', HUB_PATHS.contribution(REMOTE), JSON.stringify(payload)).status).toBe(401)
    hub.receive('POST', HUB_PATHS.register, {}, reg)
    expect(signed('PUT', HUB_PATHS.contribution(REMOTE), JSON.stringify(payload), generateInstallKey().privateKey)).toMatchObject({
      status: 401,
      signatureOk: false,
    })
    expect(signed('PUT', HUB_PATHS.contribution(REMOTE), JSON.stringify({ ...payload, title: 'raw' })).status).toBe(400)
    expect(hub.contributions.size).toBe(0)
  })

  it('DELETE withdraws one with an empty body; a body is refused', () => {
    const { hub, key, reg, signed } = setup()
    hub.receive('POST', HUB_PATHS.register, {}, reg)
    signed('PUT', HUB_PATHS.contribution(REMOTE), JSON.stringify(payload))
    expect(signed('DELETE', HUB_PATHS.contribution(REMOTE), '{}').status).toBe(400)
    expect(signed('DELETE', HUB_PATHS.contribution(REMOTE), '')).toMatchObject({ status: 200, answer: { deleted: true } })
    expect(hub.contributions.size).toBe(0)
    expect(signed('DELETE', HUB_PATHS.install(key.installId), '')).toMatchObject({ status: 200, answer: { deleted: 0 } })
  })
})
