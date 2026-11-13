import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { z } from 'zod'
import { CONTRIBUTION_AREAS, CONTRIBUTION_KINDS, CONTRIBUTION_STATUSES } from '../types'

/**
 * The wire contract between an install and the central Contribute board
 * (plan/contribute-phone-home.md §3–§4). Both ends parse with these strict
 * schemas, so a field that is not listed here cannot leave an install, and
 * the hub refuses anything else. Version 1.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')

export const hubContributionV1 = z
  .object({
    v: z.literal(1),
    /** The local contribution UUID — random, links back only for this install. */
    remote_id: z.uuid(),
    /** The LLM rewrite of the title: English, PII-free. */
    summary: z.string().min(1).max(500),
    /** BCP-47 tag of the original title's language. */
    language: z.string().min(2).max(35),
    kind: z.enum(CONTRIBUTION_KINDS),
    area: z.enum(CONTRIBUTION_AREAS),
    status: z.enum(CONTRIBUTION_STATUSES),
    /** Net votes — a count, never who voted. */
    score: z.number().int(),
    app_version: z.string().min(1).max(40),
    created_day: day,
    shipped_day: day.nullable(),
  })
  .strict()
export type HubContributionV1 = z.infer<typeof hubContributionV1>
export const HUB_CONTRIBUTION_KEYS = Object.keys(hubContributionV1.shape) as (keyof HubContributionV1)[]

export const hubRegisterV1 = z
  .object({
    v: z.literal(1),
    install_id: z.uuid(),
    /** Ed25519 public key, SPKI DER, base64. */
    public_key: z.string().min(40).max(200),
    app_version: z.string().min(1).max(40),
  })
  .strict()
export type HubRegisterV1 = z.infer<typeof hubRegisterV1>

/** Request paths on the hub (all under its origin). */
export const HUB_PATHS = {
  register: '/api/hub/register',
  contribution: (remoteId: string) => `/api/hub/contributions/${remoteId}`,
  install: (installId: string) => `/api/hub/installs/${installId}`,
} as const

export const HUB_HEADERS = {
  install: 'x-ee-install',
  timestamp: 'x-ee-timestamp',
  signature: 'x-ee-signature',
} as const

/** A signed request older or newer than this is refused (replay window). */
export const HUB_MAX_SKEW_MS = 5 * 60 * 1000

function canonical(method: string, path: string, timestamp: string, body: string): Buffer {
  const bodyHash = createHash('sha256').update(body).digest('hex')
  return Buffer.from(`v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`)
}

/** Headers for a request signed with the install's Ed25519 key (PKCS8 DER, base64). */
export function signHubRequest(input: {
  method: string
  path: string
  body: string
  installId: string
  privateKey: string
  now: number
}): Record<string, string> {
  const timestamp = String(input.now)
  const key = createPrivateKey({ key: Buffer.from(input.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  const signature = sign(null, canonical(input.method, input.path, timestamp, input.body), key).toString('base64')
  return {
    [HUB_HEADERS.install]: input.installId,
    [HUB_HEADERS.timestamp]: timestamp,
    [HUB_HEADERS.signature]: signature,
  }
}

export type HubVerifyResult = { ok: true; installId: string } | { ok: false; reason: 'headers' | 'skew' | 'signature' }

/** Checks a request against the install's registered public key (SPKI DER, base64). Replay of the same signature inside the window is the hub's to refuse. */
export function verifyHubRequest(input: {
  method: string
  path: string
  body: string
  headers: Record<string, string | undefined>
  publicKey: string
  now: number
}): HubVerifyResult {
  const installId = input.headers[HUB_HEADERS.install]
  const timestamp = input.headers[HUB_HEADERS.timestamp]
  const signature = input.headers[HUB_HEADERS.signature]
  if (!installId || !timestamp || !signature || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'headers' }
  if (Math.abs(input.now - Number(timestamp)) > HUB_MAX_SKEW_MS) return { ok: false, reason: 'skew' }
  const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64'), format: 'der', type: 'spki' })
  const good = verify(null, canonical(input.method, input.path, timestamp, input.body), key, Buffer.from(signature, 'base64'))
  return good ? { ok: true, installId } : { ok: false, reason: 'signature' }
}
