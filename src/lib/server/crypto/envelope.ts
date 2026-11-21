import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12

/**
 * The key ids an envelope may name. No `k` = the owner's own data key (the
 * tenant DEK of the row's user); 'company' = the company data key, used for
 * Memory rows every member may read (drizzle/0164).
 */
export const ENVELOPE_KEY_IDS = ['company'] as const
export type EnvelopeKeyId = (typeof ENVELOPE_KEY_IDS)[number]

export type EnvelopePayload = {
  v: 1
  iv: string
  tag: string
  data: string
  k?: EnvelopeKeyId
}

function encodeBase64(input: Uint8Array): string {
  return Buffer.from(input).toString('base64')
}

function decodeBase64(input: string): Buffer {
  return Buffer.from(input, 'base64')
}

export function encryptEnvelope(
  plaintext: string,
  key: Buffer,
  aad: string,
  keyId?: EnvelopeKeyId,
): string {
  if (key.length !== 32) {
    throw new Error('Envelope key must be 32 bytes')
  }
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const payload: EnvelopePayload = {
    v: 1,
    iv: encodeBase64(iv),
    tag: encodeBase64(tag),
    data: encodeBase64(encrypted),
    ...(keyId ? { k: keyId } : {}),
  }
  return JSON.stringify(payload)
}

export function decryptEnvelope(payloadJson: string, key: Buffer, aad: string): string {
  if (key.length !== 32) {
    throw new Error('Envelope key must be 32 bytes')
  }
  const parsed = JSON.parse(payloadJson) as Partial<EnvelopePayload>
  // `data` may be "" (empty plaintext); only iv/tag must be non-empty.
  if (
    parsed.v !== 1 ||
    typeof parsed.iv !== 'string' ||
    !parsed.iv ||
    typeof parsed.tag !== 'string' ||
    !parsed.tag ||
    typeof parsed.data !== 'string'
  ) {
    throw new Error('Invalid encrypted envelope payload')
  }
  const decipher = createDecipheriv(ALGO, key, decodeBase64(parsed.iv))
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(decodeBase64(parsed.tag))
  const plaintext = Buffer.concat([decipher.update(decodeBase64(parsed.data)), decipher.final()])
  return plaintext.toString('utf8')
}

/** The key an envelope names (null = the owner's own key). Throws on a key id it does not know. */
export function envelopeKeyId(payloadJson: string): EnvelopeKeyId | null {
  const parsed = JSON.parse(payloadJson) as Partial<EnvelopePayload> & { k?: unknown }
  if (parsed.k === undefined) return null
  if (!(ENVELOPE_KEY_IDS as readonly unknown[]).includes(parsed.k)) {
    throw new Error(`Unknown envelope key id: ${String(parsed.k)}`)
  }
  return parsed.k as EnvelopeKeyId
}
