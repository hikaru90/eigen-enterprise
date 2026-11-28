import { describe, expect, it } from 'vitest'
import { MODULE_HUB_PATHS } from '$lib/module-hub/contract'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../contracts/fixtures/module-hub-test-key'
import { verifyReceipt } from '../contracts/module-receipt'
import { HUB_PATHS, signHubRequest } from '../modules/contribute/share/contract'
import { generateInstallKey } from '../modules/contribute/share/identity'
import { bundleOf, publishBody } from '../modules/module-hub/test-fixtures'
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

describe('mock hub: module endpoints (the real module-hub service, TEST-ONLY receipt key)', () => {
  it('a registered install publishes hello and gets a receipt under the test key; an unregistered one gets 401', async () => {
    const { hub, key, reg } = setup()
    const body = publishBody(bundleOf())
    const path = MODULE_HUB_PATHS.publish
    const sign = (now: number) => signHubRequest({ method: 'POST', path, body, installId: key.installId, privateKey: key.privateKey, now })
    expect((await hub.receiveModules('POST', path, sign(NOW), body)).status).toBe(401)
    hub.receive('POST', HUB_PATHS.register, {}, reg)
    const out = await hub.receiveModules('POST', path, sign(NOW + 1), body)
    expect(out.status).toBe(201)
    const receipt = 'answer' in out ? out.answer.receipt : null
    expect(verifyReceipt(receipt, [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI])).toMatchObject({ ok: true })
    expect(hub.requests.at(-1)).toMatchObject({ method: 'POST', path, status: 201, body: expect.stringMatching(/^\(\d+ bytes\)$/) })
  })
})

describe('mock hub: product signals (plan/traces-phone-home.md T4)', () => {
  const BATCH = '22222222-2222-4222-8222-222222222222'
  const span = {
    trace_id: '11111111-1111-4111-8111-111111111111', span_id: '33333333-3333-4333-8333-333333333333', parent_id: null, kind: 'tool_call', run_kind: null,
    tool: 'memory.list_tasks', log_context: null, model: null, provider_kind: null, tokens_in: null, tokens_out: null, cost_usd: null, duration_ms: 3,
    attempt: null, start_offset_ms: 0, outcome: 'ok', error_code: null, audit_class: 'read', via: 'person', app_version: '0.5.47', ee_version: null, day: '2026-11-13',
  }
  it('takes a signed strict batch, refuses an extra key, and withdraws on DELETE', () => {
    const { hub, reg, signed } = setup()
    hub.receive('POST', HUB_PATHS.register, {}, reg)
    expect(signed('POST', '/api/hub/traces', JSON.stringify({ v: 1, batch_id: BATCH, spans: [{ ...span, context: 'Jane' }] })).status).toBe(400)
    expect(signed('POST', '/api/hub/traces', JSON.stringify({ v: 1, batch_id: BATCH, spans: [span] })).status).toBe(201)
    expect(hub.traceBatches.size).toBe(1)
    expect(signed('DELETE', '/api/hub/traces', '')).toMatchObject({ status: 200, answer: { deleted: 1 } })
    expect(hub.traceBatches.size).toBe(0)
  })
})
