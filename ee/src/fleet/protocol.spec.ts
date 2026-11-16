import { describe, expect, it } from 'vitest'
import {
  FLEET_HEADERS,
  FLEET_MAX_SKEW_MS,
  FLEET_PATHS,
  desiredV1,
  enrollRequestV1,
  newBoxKey,
  parseDesired,
  reportV1,
  signFleetRequest,
  verifyFleetRequest,
} from './protocol.ts'

const now = 1_800_000_000_000

describe('fleet signing', () => {
  const key = newBoxKey()
  const boxId = '6f1c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
  const body = JSON.stringify({ hello: 'world' })
  const headers = signFleetRequest({ boxId, privateKey: key.privateKey, method: 'post', path: FLEET_PATHS.poll, body, now })

  it('verifies a request signed with the box key', () => {
    expect(verifyFleetRequest({ publicKey: key.publicKey, method: 'POST', path: FLEET_PATHS.poll, body, headers, now })).toEqual({
      ok: true,
      boxId,
    })
  })

  it('refuses a changed body, path or method', () => {
    const v = (over: Partial<{ method: string; path: string; body: string }>) =>
      verifyFleetRequest({ publicKey: key.publicKey, method: 'POST', path: FLEET_PATHS.poll, body, headers, now, ...over })
    expect(v({ body: '{}' })).toEqual({ ok: false, reason: 'signature' })
    expect(v({ path: FLEET_PATHS.enroll })).toEqual({ ok: false, reason: 'signature' })
    expect(v({ method: 'PUT' })).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses another box key', () => {
    expect(verifyFleetRequest({ publicKey: newBoxKey().publicKey, method: 'POST', path: FLEET_PATHS.poll, body, headers, now })).toEqual({
      ok: false,
      reason: 'signature',
    })
  })

  it('refuses outside the skew window and without headers', () => {
    const late = now + FLEET_MAX_SKEW_MS + 1
    expect(verifyFleetRequest({ publicKey: key.publicKey, method: 'POST', path: FLEET_PATHS.poll, body, headers, now: late })).toEqual({
      ok: false,
      reason: 'skew',
    })
    const { [FLEET_HEADERS.signature]: _s, ...partial } = headers
    expect(verifyFleetRequest({ publicKey: key.publicKey, method: 'POST', path: FLEET_PATHS.poll, body, headers: partial, now })).toEqual({
      ok: false,
      reason: 'headers',
    })
  })
})

describe('fleet messages', () => {
  it('enroll is strict', () => {
    const ok = { protocol: 1, enrollToken: 'x'.repeat(40), publicKey: 'AAAA', eeVersion: '0.5.12', features: ['release'] }
    expect(enrollRequestV1.parse(ok)).toEqual(ok)
    expect(() => enrollRequestV1.parse({ ...ok, extra: 1 })).toThrow()
    expect(() => enrollRequestV1.parse({ ...ok, features: ['shell'] })).toThrow()
  })

  it('a report carries what the control plane needs and nothing else', () => {
    const r = {
      protocol: 1,
      eeVersion: '0.5.12',
      features: ['release', 'suspended'],
      release: 'eigenenterprise-0.5.12-0c8909ab5d16-linux-arm64.tar.gz',
      health: { os: 'healthy', reconcileError: null },
      seats: 2,
      hosts: ['acme.example.com', 'rtc.acme.example.com'],
      disk: { usedGb: 3.2, totalGb: 40 },
      backup: { lastOkAt: '2026-11-16T03:17:00Z', lastError: null },
    }
    expect(reportV1.parse(r)).toEqual({ ...r, ignoredFields: [] })
    expect(() => reportV1.parse({ ...r, env: { SECRET: 'x' } })).toThrow()
  })

  it('a newer control plane never breaks an older box: unknown fields are ignored and named', () => {
    const { desired, ignoredFields } = parseDesired({ protocol: 1, pollSeconds: 60, suspended: false, supportSession: { until: 'x' } })
    expect(desired).toEqual({ protocol: 1, pollSeconds: 60, suspended: false })
    expect(ignoredFields).toEqual(['supportSession'])
  })

  it('known fields are still validated', () => {
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 5 })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, release: { name: 'x', from: 'http://insecure' } })).toThrow()
    expect(() =>
      desiredV1.parse({ protocol: 1, pollSeconds: 60, platformAi: { llmBaseUrl: 'https://a.b', llmApiKey: 'k', llmModelChat: 'c', llmModelEmbedding: 'e', extra: 1 } }),
    ).toThrow()
  })
})
