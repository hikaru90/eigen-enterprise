import { createHash } from 'node:crypto'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'

/**
 * Sealing for pasted GitHub tokens (plan/github-drive.md §1): AES-256-GCM
 * (`envelope.ts`) with a key derived for this purpose only from the instance
 * TENANT_MASTER_KEY, the AAD bound to the token's row id, so a sealed value
 * can't be moved to another row.
 */

const PURPOSE = 'repo-source-token'

export function tokenSealKey(masterKey: string | undefined): Buffer {
  const k = masterKey?.trim()
  if (!k) throw new Error('TENANT_MASTER_KEY is required to store a GitHub token')
  return createHash('sha256').update(`${PURPOSE}:${k}`, 'utf8').digest()
}

export function sealToken(token: string, key: Buffer, tokenId: string): string {
  return encryptEnvelope(token, key, tokenId)
}

export function unsealToken(sealed: string, key: Buffer, tokenId: string): string {
  return decryptEnvelope(sealed, key, tokenId)
}

/** What the page may show of a token: its last four characters. */
export function last4(token: string): string {
  return token.slice(-4)
}
