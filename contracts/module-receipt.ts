import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import { z } from 'zod'

/**
 * The hub's receipt for a published module bundle (plan/phase-upgrades-u2.md
 * §6.3): ee runs only bytes a trusted hub key signed for. Imported by ee too,
 * so only `zod` and `node:*`.
 *
 * Keys are Ed25519: the public key as base64 DER SPKI, the private key as
 * base64 DER PKCS#8.
 */

export const RECEIPT_KIND = 'eigen.module-receipt' as const
export const RECEIPT_SIGNING_PREFIX = 'eigen.module-receipt.v1\n'

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

const fieldsShape = {
  hub: z
    .string()
    .max(400)
    .refine((s) => /^https?:\/\/[^/\s]+$/.test(s), {
      message: 'the hub origin (scheme://host[:port])',
    }),
  installId: z.string().min(1).max(200),
  moduleId: z.string().min(2).max(24).regex(MODULE_ID),
  version: z.string().regex(SEMVER),
  commit: z.string().regex(HEX40, '40 lowercase hex'),
  bundleSha256: z.string().regex(HEX64, '64 lowercase hex'),
  manifestSha256: z.string().regex(HEX64, '64 lowercase hex'),
  /** The core-api version of the box that published (its CORE_API_VERSION). */
  coreApi: z.string().regex(SEMVER),
  license: z.literal('Apache-2.0'),
  deprecatedUses: z.array(z.string().min(1).max(200)),
  issuedAt: z.iso.datetime(),
}

/** The fields the hub fills; signReceipt adds v, kind, keyId and signature. */
export const moduleReceiptFieldsSchema = z.strictObject(fieldsShape)
export type ModuleReceiptFields = z.output<typeof moduleReceiptFieldsSchema>

export const moduleReceiptSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal(RECEIPT_KIND),
  keyId: z.string().regex(/^[0-9a-f]{16}$/, 'first 16 hex of sha256(hub SPKI)'),
  ...fieldsShape,
  signature: z.string().regex(BASE64, 'base64'),
})
export type ModuleReceiptV1 = z.output<typeof moduleReceiptSchema>

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON: a number is not finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  throw new Error(`canonical JSON: a ${typeof value} has no JSON form`)
}

/** Canonical JSON of every receipt field but `signature` (keys sorted, no whitespace). */
export function canonicalReceiptJson(receipt: Omit<ModuleReceiptV1, 'signature'>): string {
  const { signature: _drop, ...rest } = receipt as ModuleReceiptV1
  return canonical(rest)
}

/** The exact bytes the signature covers. */
export function receiptSigningPayload(receipt: Omit<ModuleReceiptV1, 'signature'>): Buffer {
  return Buffer.from(RECEIPT_SIGNING_PREFIX + canonicalReceiptJson(receipt), 'utf8')
}

function spkiDer(spkiB64: string): Buffer {
  if (!BASE64.test(spkiB64)) throw new Error('a hub public key must be base64 DER SPKI')
  return Buffer.from(spkiB64, 'base64')
}

/** The key id: the first 16 hex of sha256 over the SPKI DER bytes. */
export function keyId(spkiB64: string): string {
  return createHash('sha256').update(spkiDer(spkiB64)).digest('hex').slice(0, 16)
}

function ed25519Public(spkiB64: string): KeyObject {
  const key = createPublicKey({ key: spkiDer(spkiB64), format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('a hub public key must be Ed25519')
  return key
}

/** Signs `fields` with the hub's Ed25519 private key (base64 DER PKCS#8). */
export function signReceipt(fields: ModuleReceiptFields, pkcs8b64: string): ModuleReceiptV1 {
  const checked = moduleReceiptFieldsSchema.parse(fields)
  if (!BASE64.test(pkcs8b64)) throw new Error('the hub signing key must be base64 DER PKCS#8')
  const privateKey = createPrivateKey({
    key: Buffer.from(pkcs8b64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  })
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('the hub signing key must be Ed25519')
  const spki = createPublicKey(privateKey)
    .export({ format: 'der', type: 'spki' })
    .toString('base64')
  const unsigned = { v: 1 as const, kind: RECEIPT_KIND, keyId: keyId(spki), ...checked }
  const signature = sign(null, receiptSigningPayload(unsigned), privateKey).toString('base64')
  return { ...unsigned, signature }
}

export type ReceiptVerification =
  { ok: true; receipt: ModuleReceiptV1 } | { ok: false; problem: string }

/**
 * Verifies `receipt` under one of `trustedSpki` (base64 DER SPKI, Ed25519):
 * the shape strictly, then the key by `keyId`, then the signature. The first
 * failure is named. Contents (ids, shas) are the caller's to compare.
 */
export function verifyReceipt(
  receipt: unknown,
  trustedSpki: readonly string[],
): ReceiptVerification {
  const parsed = moduleReceiptSchema.safeParse(receipt)
  if (!parsed.success) {
    const i = parsed.error.issues[0]!
    return { ok: false, problem: `receipt ${i.path.join('.') || 'shape'}: ${i.message}` }
  }
  const r = parsed.data
  const spki = trustedSpki.find((k) => keyId(k) === r.keyId)
  if (spki === undefined)
    return { ok: false, problem: `receipt key ${r.keyId} is not a trusted hub key` }
  const signature = Buffer.from(r.signature, 'base64')
  if (signature.byteLength !== 64)
    return { ok: false, problem: 'receipt signature is not 64 bytes' }
  const { signature: _drop, ...unsigned } = r
  if (!verify(null, receiptSigningPayload(unsigned), ed25519Public(spki), signature))
    return { ok: false, problem: 'receipt signature does not verify under its hub key' }
  return { ok: true, receipt: r }
}
