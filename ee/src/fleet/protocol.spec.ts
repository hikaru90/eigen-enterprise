import { describe, expect, it } from 'vitest'
import {
  FLEET_FEATURES,
  FLEET_HEADERS,
  FLEET_MAX_SKEW_MS,
  FLEET_PATHS,
  PLATFORM_AI_PROVIDERS,
  aiUsageDayV1,
  desiredV1,
  enrollRequestV1,
  escrowRequestV1,
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
    expect(() => enrollRequestV1.parse({ ...ok, features: [''] })).toThrow()
  })

  it('a newer box never breaks an older control plane: features it does not know are dropped, not refused', () => {
    // 2026-11-23: ee-one on v0.5.35 announced `claims` to a control plane that predated it; every poll was refused.
    const enroll = { protocol: 1, enrollToken: 'x'.repeat(40), publicKey: 'AAAA', eeVersion: '0.9.0', features: ['release', 'teleport'] }
    expect(enrollRequestV1.parse(enroll).features).toEqual(['release'])
    const report = {
      protocol: 1,
      eeVersion: '0.9.0',
      features: ['release', 'teleport', 'claims'],
      release: null,
      health: { os: 'healthy', reconcileError: null },
      seats: null,
      hosts: [],
      disk: null,
      backup: null,
    }
    expect(reportV1.parse(report).features).toEqual(['release', 'claims'])
    expect(() => reportV1.parse({ ...report, features: ['x'.repeat(65)] })).toThrow()
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

describe('platform AI provider (feature platformAiProvider)', () => {
  const ai = { llmBaseUrl: 'https://api.opper.ai/v3/compat', llmApiKey: 'k', llmModelChat: 'c', llmModelEmbedding: 'e' }

  it('is an announced feature, appended after hostedAddress', () => {
    expect(FLEET_FEATURES.indexOf('platformAiProvider')).toBe(FLEET_FEATURES.indexOf('hostedAddress') + 1)
    expect(PLATFORM_AI_PROVIDERS).toEqual(['openrouter', 'opper'])
  })

  it('platformAi may name its provider; without it the v1 meaning holds (OpenRouter)', () => {
    expect(desiredV1.parse({ protocol: 1, pollSeconds: 60, platformAi: { ...ai, provider: 'opper' } }).platformAi?.provider).toBe('opper')
    expect(desiredV1.parse({ protocol: 1, pollSeconds: 60, platformAi: ai }).platformAi?.provider).toBeUndefined()
  })

  it('an unknown provider is refused, never guessed', () => {
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, platformAi: { ...ai, provider: 'eurouter' } })).toThrow()
  })
})

describe('AI usage (feature aiUsage)', () => {
  const row = { day: '2026-11-27', task: 'assistant.turn', model: 'openai/gpt-5-mini', calls: 3, promptTokens: 120, completionTokens: 40, cachedTokens: 0, costUsd: 0.0012 }

  it('is appended after platformAiProvider', () => {
    expect(FLEET_FEATURES.at(-1)).toBe('aiUsage')
    expect(FLEET_FEATURES.indexOf('aiUsage')).toBe(FLEET_FEATURES.indexOf('platformAiProvider') + 1)
  })

  it('the report carries usage rows; unattributed rows keep task/model null', () => {
    const r = aiUsageDayV1.parse({ ...row, task: null, model: null })
    expect(r.task).toBeNull()
    expect(() => aiUsageDayV1.parse({ ...row, costUsd: -1 })).toThrow()
    expect(() => aiUsageDayV1.parse({ ...row, day: '27.11.2026' })).toThrow()
    expect(() => aiUsageDayV1.parse({ ...row, extra: 1 })).toThrow()
  })

  it('desired names the first day to report and the EUR billing', () => {
    const d = desiredV1.parse({ protocol: 1, pollSeconds: 60, aiUsage: { from: '2026-11-01', markup: 1.2, currency: 'EUR', usdToEur: 0.95, rateDay: '2026-11-27' } })
    expect(d.aiUsage?.usdToEur).toBe(0.95)
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, aiUsage: { from: '2026-11-01', markup: 1.2, currency: 'USD', usdToEur: 0.95, rateDay: '2026-11-27' } })).toThrow()
  })

  it('platformAi may carry a usage tag in Opper\'s tag-value alphabet', () => {
    const ai = { llmBaseUrl: 'https://api.opper.ai/v3/compat', llmApiKey: 'k', llmModelChat: 'c', llmModelEmbedding: 'e', provider: 'opper' as const }
    expect(desiredV1.parse({ protocol: 1, pollSeconds: 60, platformAi: { ...ai, usageTag: 'box_1a2b' } }).platformAi?.usageTag).toBe('box_1a2b')
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, platformAi: { ...ai, usageTag: 'a b' } })).toThrow()
  })
})

describe('managed mail', () => {
  const mail = {
    region: 'eu-central-1',
    accessKeyId: 'AKIAMAIL',
    secretAccessKey: 'SECRET-MAIL',
    tenant: 'ee-box',
    configurationSet: 'ee-box',
    trackingConfigurationSet: 'ee-box-tracking',
    eventsTopicArn: 'arn:aws:sns:eu-central-1:1:events',
    inboundTopicArn: 'arn:aws:sns:eu-central-1:1:inbound',
    inboundBucket: 'ee-inbound',
    inboundPrefix: 'box/',
  }
  const report = {
    protocol: 1, eeVersion: '0.5.12', features: ['mail'], release: null, health: { os: 'healthy', reconcileError: null },
    seats: null, hosts: [], disk: null, backup: null,
  }

  it('mail is a feature', () => {
    expect(FLEET_FEATURES).toContain('mail')
  })

  it('desired.mail is strict, nullable, optional; every field a non-empty string', () => {
    expect(parseDesired({ protocol: 1, pollSeconds: 60, mail }).desired.mail).toEqual(mail)
    expect(parseDesired({ protocol: 1, pollSeconds: 60, mail: null }).desired.mail).toBeNull()
    expect(parseDesired({ protocol: 1, pollSeconds: 60 }).desired.mail).toBeUndefined()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, mail: { ...mail, extra: 1 } })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, mail: { ...mail, tenant: '' } })).toThrow()
    const { inboundPrefix: _p, ...partial } = mail
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, mail: partial })).toThrow()
  })

  it('report.mail carries the domains, optional and nullable, strict', () => {
    const domains = [{ name: 'acme.example.com', receive: true }]
    expect(reportV1.parse({ ...report, mail: { domains } }).mail).toEqual({ domains })
    expect(reportV1.parse({ ...report, mail: null }).mail).toBeNull()
    expect(reportV1.parse(report).mail).toBeUndefined()
    expect(() => reportV1.parse({ ...report, mail: { domains, extra: 1 } })).toThrow()
    expect(() => reportV1.parse({ ...report, mail: { domains: [{ name: 'a.b', receive: true, x: 1 }] } })).toThrow()
    expect(() => reportV1.parse({ ...report, mail: { domains: [{ name: 'x'.repeat(254), receive: true }] } })).toThrow()
    expect(() => reportV1.parse({ ...report, mail: { domains: Array.from({ length: 51 }, (_, i) => ({ name: `d${i}.com`, receive: false })) } })).toThrow()
  })
})

describe('managed domains', () => {
  const domains = { apiBase: 'https://cloud.example.com', token: 'd'.repeat(43) }

  it('domains is a feature, appended after mail', () => {
    expect(FLEET_FEATURES.indexOf('domains')).toBe(FLEET_FEATURES.indexOf('mail') + 1)
  })

  it('desired.domains is strict, nullable, optional; https api base and a 32–256 char token', () => {
    expect(parseDesired({ protocol: 1, pollSeconds: 60, domains }).desired.domains).toEqual(domains)
    expect(parseDesired({ protocol: 1, pollSeconds: 60, domains: null }).desired.domains).toBeNull()
    expect(parseDesired({ protocol: 1, pollSeconds: 60 }).desired.domains).toBeUndefined()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, domains: { ...domains, extra: 1 } })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, domains: { ...domains, apiBase: 'http://cloud.example.com' } })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, domains: { ...domains, token: 'short' } })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, domains: { apiBase: domains.apiBase } })).toThrow()
  })
})

describe('domain claims (plan/domains-one-claim.md D4)', () => {
  const claim = { host: 'www.acme.com', verified: false, txtName: '_ee-verify.www.acme.com', txtValue: 'tok-' + 'a'.repeat(40) }

  it('claims is a feature, appended right after domains', () => {
    expect(FLEET_FEATURES.indexOf('claims')).toBe(FLEET_FEATURES.indexOf('domains') + 1)
  })

  it('hostedAddress is a feature, appended after claims (plan/hosted-address.md H1; append only)', () => {
    expect(FLEET_FEATURES.indexOf('hostedAddress')).toBe(FLEET_FEATURES.indexOf('claims') + 1)
  })

  it('desired.hostedAddress is a strict, nullable, optional { mailDomain, siteHost }', () => {
    const base = { protocol: 1, pollSeconds: 60 }
    const hosted = { mailDomain: 'acme.eigenenterprise.app', siteHost: 'www.acme.eigenenterprise.app' }
    expect(desiredV1.parse({ ...base, hostedAddress: hosted }).hostedAddress).toEqual(hosted)
    expect(desiredV1.parse({ ...base, hostedAddress: null }).hostedAddress).toBeNull()
    expect(desiredV1.parse(base).hostedAddress).toBeUndefined()
    expect(() => desiredV1.parse({ ...base, hostedAddress: { ...hosted, extra: 1 } })).toThrow()
    expect(() => desiredV1.parse({ ...base, hostedAddress: { mailDomain: '' , siteHost: 'x' } })).toThrow()
  })

  it('desired.claims is a strict, nullable, optional list of { host, verified, txtName, txtValue }', () => {
    const verified = { ...claim, host: 'acme.com', txtName: '_ee-verify.acme.com', verified: true }
    expect(parseDesired({ protocol: 1, pollSeconds: 60, claims: [claim, verified] })).toEqual({
      desired: { protocol: 1, pollSeconds: 60, claims: [claim, verified] },
      ignoredFields: [],
    })
    expect(parseDesired({ protocol: 1, pollSeconds: 60, claims: [] }).desired.claims).toEqual([])
    expect(parseDesired({ protocol: 1, pollSeconds: 60, claims: null }).desired.claims).toBeNull()
    expect(parseDesired({ protocol: 1, pollSeconds: 60 }).desired.claims).toBeUndefined()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, claims: [{ ...claim, extra: 1 }] })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, claims: [{ ...claim, verified: 'yes' }] })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, claims: [{ ...claim, host: '' }] })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, claims: [{ ...claim, txtValue: '' }] })).toThrow()
    const { txtName: _n, ...partial } = claim
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, claims: [partial] })).toThrow()
    expect(() => desiredV1.parse({ protocol: 1, pollSeconds: 60, claims: claim })).toThrow()
  })
})

describe('escrow (the control plane keeps a copy of the backup key)', () => {
  const backupKey = Buffer.alloc(32, 7).toString('base64')

  it('carries exactly one 32-byte base64 backup key', () => {
    expect(escrowRequestV1.parse({ protocol: 1, backupKey })).toEqual({ protocol: 1, backupKey })
    expect(() => escrowRequestV1.parse({ protocol: 1, backupKey: Buffer.alloc(16).toString('base64') })).toThrow()
    expect(() => escrowRequestV1.parse({ protocol: 1, backupKey, recoveryCode: 'EE1-x' })).toThrow()
  })

  it('the desired state may ask for it', () => {
    const { desired, ignoredFields } = parseDesired({ protocol: 1, pollSeconds: 60, escrowBackupKey: true })
    expect(desired.escrowBackupKey).toBe(true)
    expect(ignoredFields).toEqual([])
    expect(FLEET_PATHS.escrow).toBe('/api/fleet/v1/escrow')
  })
})
