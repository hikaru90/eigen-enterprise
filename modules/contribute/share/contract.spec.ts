import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  HUB_CONTRIBUTION_KEYS,
  HUB_MAX_SKEW_MS,
  hubContributionV1,
  hubRegisterV1,
  signHubRequest,
  verifyHubRequest,
} from './contract'

const valid = {
  v: 1,
  remote_id: '6f1c0f7e-6a43-4a5e-9d0b-6f0f3c1d2e4a',
  summary: 'Let people reorder the drive sidebar sections.',
  language: 'de',
  kind: 'idea',
  area: 'drive',
  status: 'requested',
  score: 3,
  app_version: '0.5.9',
  created_day: '2026-11-13',
  shipped_day: null,
} as const

describe('hub contract: contribution payload v1', () => {
  it('has exactly the allowlisted keys — adding one is a reviewed change', () => {
    expect([...HUB_CONTRIBUTION_KEYS].sort()).toEqual(
      [
        'app_version',
        'area',
        'created_day',
        'kind',
        'language',
        'remote_id',
        'score',
        'shipped_day',
        'status',
        'summary',
        'v',
      ].sort(),
    )
  })

  it('accepts a valid payload', () => {
    expect(hubContributionV1.parse(valid)).toEqual(valid)
  })

  it('rejects any extra key (author, note, company…)', () => {
    for (const extra of ['author_id', 'authorName', 'note', 'company', 'title', 'created_at']) {
      expect(hubContributionV1.safeParse({ ...valid, [extra]: 'x' }).success).toBe(false)
    }
  })

  it('rejects a timestamp where a day belongs, an over-long summary and unknown enums', () => {
    expect(hubContributionV1.safeParse({ ...valid, created_day: '2026-11-13T10:00:00Z' }).success).toBe(false)
    expect(hubContributionV1.safeParse({ ...valid, summary: 'x'.repeat(501) }).success).toBe(false)
    expect(hubContributionV1.safeParse({ ...valid, summary: '' }).success).toBe(false)
    expect(hubContributionV1.safeParse({ ...valid, kind: 'rant' }).success).toBe(false)
    expect(hubContributionV1.safeParse({ ...valid, v: 2 }).success).toBe(false)
  })

  it('register body is strict too', () => {
    const body = { v: 1, install_id: valid.remote_id, public_key: 'MCowBQYDK2VwAyEA' + 'A'.repeat(44), app_version: '0.5.9' }
    expect(hubRegisterV1.parse(body)).toEqual(body)
    expect(hubRegisterV1.safeParse({ ...body, company: 'Kindred' }).success).toBe(false)
  })
})

describe('hub contract: request signatures', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  const req = { method: 'PUT', path: `/api/hub/contributions/${valid.remote_id}`, body: JSON.stringify(valid) }
  const now = 1_794_500_000_000

  it('verifies a request it signed', () => {
    const headers = signHubRequest({ ...req, installId: valid.remote_id, privateKey: priv, now })
    expect(verifyHubRequest({ ...req, headers, publicKey: pub, now })).toEqual({ ok: true, installId: valid.remote_id })
  })

  it('refuses a changed body, path or method', () => {
    const headers = signHubRequest({ ...req, installId: valid.remote_id, privateKey: priv, now })
    expect(verifyHubRequest({ ...req, body: req.body.replace('3', '4'), headers, publicKey: pub, now }).ok).toBe(false)
    expect(verifyHubRequest({ ...req, path: '/api/hub/contributions/other', headers, publicKey: pub, now }).ok).toBe(false)
    expect(verifyHubRequest({ ...req, method: 'DELETE', headers, publicKey: pub, now }).ok).toBe(false)
  })

  it('refuses a request outside the clock skew window', () => {
    const headers = signHubRequest({ ...req, installId: valid.remote_id, privateKey: priv, now })
    const late = verifyHubRequest({ ...req, headers, publicKey: pub, now: now + HUB_MAX_SKEW_MS + 1 })
    expect(late).toEqual({ ok: false, reason: 'skew' })
  })

  it('refuses another install key', () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const headers = signHubRequest({ ...req, installId: valid.remote_id, privateKey: priv, now })
    expect(verifyHubRequest({ ...req, headers, publicKey: other, now })).toEqual({ ok: false, reason: 'signature' })
  })
})
