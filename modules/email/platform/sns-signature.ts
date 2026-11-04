import { createPublicKey, createVerify } from 'node:crypto'
import { z } from 'zod'

/**
 * Amazon SNS message signature verification (AWS "Verifying the signatures of
 * Amazon SNS messages"). Every POST to /api/mail/ses-events is checked here
 * before anything is read from it: the signing certificate must come from an
 * SNS host over HTTPS, and the canonical string must verify with it
 * (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA).
 */

export const snsMessage = z.object({
  Type: z.enum(['Notification', 'SubscriptionConfirmation', 'UnsubscribeConfirmation']),
  MessageId: z.string().min(1),
  TopicArn: z.string().min(1),
  Message: z.string(),
  Timestamp: z.string().min(1),
  SignatureVersion: z.enum(['1', '2']),
  Signature: z.string().min(1),
  SigningCertURL: z.string().min(1),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Token: z.string().optional(),
})

export type SnsMessage = z.infer<typeof snsMessage>

export class SnsSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SnsSignatureError'
  }
}

/** sns.<region>.amazonaws.com (or .amazonaws.com.cn) — the only hosts SNS signs from or sends links to. */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/

/** True for an https URL on an SNS host (signing certs, SubscribeURL). */
export function isSnsUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && SNS_HOST.test(u.hostname) && !u.username && !u.password && !u.port
  } catch {
    return false
  }
}

/** The canonical string SNS signs: "Key\nValue\n" for each present key, in AWS's fixed order. */
export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? (['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'] as const)
      : (['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'] as const)
  let out = ''
  for (const k of keys) {
    const v = m[k]
    if (v === undefined) continue
    out += `${k}\n${v}\n`
  }
  return out
}

export type CertFetcher = (url: string) => Promise<string>

/** Fetches a signing certificate over HTTPS, cached per URL for the process lifetime (SNS rotates by URL). */
export function cachedCertFetcher(fetchImpl: typeof fetch = fetch): CertFetcher {
  const cache = new Map<string, Promise<string>>()
  return (url) => {
    let hit = cache.get(url)
    if (!hit) {
      hit = (async () => {
        const res = await fetchImpl(url, { redirect: 'error' })
        if (!res.ok) throw new SnsSignatureError(`Could not fetch the SNS signing certificate (HTTP ${res.status}).`)
        return res.text()
      })()
      hit.catch(() => cache.delete(url))
      cache.set(url, hit)
    }
    return hit
  }
}

/** Parses + verifies a raw SNS POST body. Throws SnsSignatureError on anything that is not a genuine SNS message. */
export async function verifySnsMessage(body: unknown, fetchCert: CertFetcher): Promise<SnsMessage> {
  const parsed = snsMessage.safeParse(body)
  if (!parsed.success) throw new SnsSignatureError('This is not an Amazon SNS message.')
  const m = parsed.data
  if (!isSnsUrl(m.SigningCertURL) || !new URL(m.SigningCertURL).pathname.endsWith('.pem')) {
    throw new SnsSignatureError('The SNS signing certificate does not come from Amazon SNS.')
  }
  if (m.Type !== 'Notification' && (!m.SubscribeURL || !m.Token)) {
    throw new SnsSignatureError('The SNS subscription message is missing its SubscribeURL or Token.')
  }
  const pem = await fetchCert(m.SigningCertURL)
  if (!signatureVerifies(m, pem)) throw new SnsSignatureError('The SNS message signature does not verify.')
  return m
}

function signatureVerifies(m: SnsMessage, pem: string): boolean {
  try {
    const verifier = createVerify(m.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256')
    verifier.update(stringToSign(m), 'utf8')
    return verifier.verify(createPublicKey(pem), m.Signature, 'base64')
  } catch {
    // A malformed certificate or signature is simply not a valid signature.
    return false
  }
}
