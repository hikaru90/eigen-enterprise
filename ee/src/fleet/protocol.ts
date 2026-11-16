import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { z } from 'zod'

/**
 * The fleet protocol (plan/phase-managed-box.md): the wire contract between a
 * MANAGED box (an ee install the hosting control plane runs for a company) and
 * that control plane. Self-hosted installs never speak it.
 *
 * - The box pulls; the control plane never connects in. No SSH, no inbound port.
 * - Level-triggered, like ee's own reconcile: every poll carries the box's full
 *   report and gets the full desired state back. A lost answer is repaired by
 *   the next poll; there is no command queue and no "run this" verb.
 * - Extensible: the box announces the desired-state `features` it understands.
 *   The control plane sets only those; the box ignores (and reports) fields it
 *   doesn't know, so a newer control plane never breaks an older box.
 * - Signed like the Contribute hub (modules/contribute/share/contract.ts): an
 *   Ed25519 key per box, minted at enrollment, its private half sealed in ee's
 *   secret store. Responses are trusted through HTTPS to the configured origin.
 *
 * The control plane (a separate, private repo) vendors this file verbatim.
 */

export const FLEET_PROTOCOL = 1 as const

export const FLEET_PATHS = {
  /** One-time: trade the enrollment token (from cloud-init) for a box id. Unsigned. */
  enroll: '/api/fleet/v1/enroll',
  /** Every pollSeconds: report in, desired state out. Signed. */
  poll: '/api/fleet/v1/poll',
} as const

export const FLEET_HEADERS = {
  box: 'x-ee-box',
  timestamp: 'x-ee-timestamp',
  signature: 'x-ee-signature',
} as const

/** A signed request older or newer than this is refused. */
export const FLEET_MAX_SKEW_MS = 5 * 60 * 1000

/** Poll interval bounds the control plane may ask for. */
export const POLL_SECONDS = { min: 15, max: 3600, default: 60 } as const

/**
 * Desired-state features. A box lists the ones it implements; the control plane
 * must leave every other field at its neutral value for that box. New features
 * are added here (append only), never repurposed.
 */
export const FLEET_FEATURES = ['release', 'suspended', 'backup', 'platformAi', 'backupRequestedAt'] as const
export type FleetFeature = (typeof FLEET_FEATURES)[number]

const base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/)
const isoTime = z.iso.datetime({ offset: true })
const httpsOrigin = z.url().refine((u) => new URL(u).protocol === 'https:', { message: 'must be https' })

// ── enroll ───────────────────────────────────────────────────────────────────

export const enrollRequestV1 = z
  .object({
    protocol: z.literal(FLEET_PROTOCOL),
    /** One-time token the control plane put in the VM's cloud-init. */
    enrollToken: z.string().min(32).max(128),
    /** The box's new Ed25519 public key, SPKI DER, base64. */
    publicKey: base64,
    eeVersion: z.string().min(1).max(64),
    features: z.array(z.enum(FLEET_FEATURES)),
  })
  .strict()
export type EnrollRequestV1 = z.infer<typeof enrollRequestV1>

export const enrollResponseV1 = z
  .object({
    boxId: z.uuid(),
    pollSeconds: z.number().int().min(POLL_SECONDS.min).max(POLL_SECONDS.max),
  })
  .strict()
export type EnrollResponseV1 = z.infer<typeof enrollResponseV1>

// ── poll: the report ─────────────────────────────────────────────────────────

export const reportV1 = z
  .object({
    protocol: z.literal(FLEET_PROTOCOL),
    eeVersion: z.string().min(1).max(64),
    features: z.array(z.enum(FLEET_FEATURES)),
    /** Basename of the os release tarball running now; null before the first deploy. */
    release: z.string().max(200).nullable(),
    health: z
      .object({
        os: z.enum(['healthy', 'unhealthy', 'unknown']),
        /** ee's last reconcile error (one line), null when applied == desired. */
        reconcileError: z.string().max(2000).nullable(),
      })
      .strict(),
    /** Active human members (billing seats), from os; null when os can't say. */
    seats: z.number().int().min(0).nullable(),
    /** Every host the box routes (console, calls, website, custom domains): the host router learns them here. */
    hosts: z.array(z.string().min(1).max(253)).max(200),
    disk: z.object({ usedGb: z.number().min(0), totalGb: z.number().min(0) }).strict().nullable(),
    backup: z
      .object({ lastOkAt: isoTime.nullable(), lastError: z.string().max(2000).nullable() })
      .strict()
      .nullable(),
    /** Desired-state fields the box received but doesn't implement (so the control plane can see drift). */
    ignoredFields: z.array(z.string().max(64)).max(50).default([]),
  })
  .strict()
export type ReportV1 = z.infer<typeof reportV1>

// ── poll: the desired state ─────────────────────────────────────────────────

export const backupTargetV1 = z
  .object({
    endpoint: httpsOrigin,
    region: z.string().min(1).max(64),
    bucket: z.string().min(3).max(63),
    prefix: z.string().max(200),
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(1).max(256),
  })
  .strict()

export const platformAiV1 = z
  .object({
    /** The os workload's LLM_BASE_URL / LLM_API_KEY / LLM_MODEL_CHAT / LLM_MODEL_EMBEDDING (the gateway's platform path). */
    llmBaseUrl: httpsOrigin,
    llmApiKey: z.string().min(1).max(512),
    llmModelChat: z.string().min(1).max(200),
    llmModelEmbedding: z.string().min(1).max(200),
  })
  .strict()

/** Known fields, each optional so a box can tell "not sent" from "sent as null". */
const desiredKnown = {
  protocol: z.literal(FLEET_PROTOCOL),
  pollSeconds: z.number().int().min(POLL_SECONDS.min).max(POLL_SECONDS.max),
  /** The os release to run: `ee upgrade --from <from>` until `name` runs. null = leave as is. */
  release: z.object({ name: z.string().min(1).max(200), from: httpsOrigin }).strict().nullable().optional(),
  /** true: every host answers 503 "paused" (data and services untouched); false: normal. */
  suspended: z.boolean().optional(),
  /** Where `ee backup` sends snapshots; null = no managed backups. */
  backup: backupTargetV1.nullable().optional(),
  /** The platform AI provider for people without their own (billed by the control plane). */
  platformAi: platformAiV1.nullable().optional(),
  /** Take a backup if the last good one is older than this. */
  backupRequestedAt: isoTime.nullable().optional(),
}

export const desiredV1 = z.object(desiredKnown).strip()
export type DesiredV1 = z.infer<typeof desiredV1>

/** Parse a desired state and name the top-level fields this box doesn't know (they are ignored, never fatal). */
export function parseDesired(raw: unknown): { desired: DesiredV1; ignoredFields: string[] } {
  const desired = desiredV1.parse(raw)
  const known = new Set(Object.keys(desiredKnown))
  const ignoredFields =
    raw && typeof raw === 'object' ? Object.keys(raw).filter((k) => !known.has(k)).sort() : []
  return { desired, ignoredFields }
}

// ── signing ──────────────────────────────────────────────────────────────────

function canonical(method: string, path: string, timestamp: string, body: string): Buffer {
  const bodyHash = createHash('sha256').update(body).digest('hex')
  return Buffer.from(`fleet-v1\n${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`)
}

/** A new box key: private PKCS8 DER base64 (sealed in ee's secret store), public SPKI DER base64 (sent at enroll). */
export function newBoxKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }
}

export function signFleetRequest(input: {
  boxId: string
  privateKey: string
  method: string
  path: string
  body: string
  now: number
}): Record<string, string> {
  const key = createPrivateKey({ key: Buffer.from(input.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
  const timestamp = String(input.now)
  return {
    [FLEET_HEADERS.box]: input.boxId,
    [FLEET_HEADERS.timestamp]: timestamp,
    [FLEET_HEADERS.signature]: sign(null, canonical(input.method, input.path, timestamp, input.body), key).toString('base64'),
  }
}

export type FleetVerifyResult = { ok: true; boxId: string } | { ok: false; reason: 'headers' | 'skew' | 'signature' }

/** The control plane's check, against the box's enrolled public key. Refusing a replayed signature inside the window is the control plane's job. */
export function verifyFleetRequest(input: {
  publicKey: string
  method: string
  path: string
  body: string
  headers: Record<string, string | undefined>
  now: number
}): FleetVerifyResult {
  const boxId = input.headers[FLEET_HEADERS.box]
  const timestamp = input.headers[FLEET_HEADERS.timestamp]
  const signature = input.headers[FLEET_HEADERS.signature]
  if (!boxId || !timestamp || !signature || !/^\d+$/.test(timestamp)) return { ok: false, reason: 'headers' }
  if (Math.abs(input.now - Number(timestamp)) > FLEET_MAX_SKEW_MS) return { ok: false, reason: 'skew' }
  const key = createPublicKey({ key: Buffer.from(input.publicKey, 'base64'), format: 'der', type: 'spki' })
  const good = verify(null, canonical(input.method, input.path, timestamp, input.body), key, Buffer.from(signature, 'base64'))
  return good ? { ok: true, boxId } : { ok: false, reason: 'signature' }
}
