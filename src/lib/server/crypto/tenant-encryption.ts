import { getOrCreateCompanyDek } from '$lib/server/crypto/company-keys'
import { decryptEnvelope, encryptEnvelope, envelopeKeyId } from '$lib/server/crypto/envelope'
import { getOrCreateTenantDek } from '$lib/server/crypto/tenant-keys'
import { tenantUserAsyncLocal } from '$lib/server/db/tenant-context'

/**
 * Which key seals a Memory value: 'person' = the row owner's tenant DEK (the
 * default, private rows); 'company' = the company data key, for rows every
 * member may read (a shared project's tasks, shared notes — drizzle/0164).
 * The envelope names its key ("k": "company"), so decryption needs no guess.
 */
export type EncryptionScope = 'person' | 'company'

function aadFor(userId: string, table: string, column: string): string {
  return `tenant:${userId}|table:${table}|column:${column}`
}

/** Company-sealed values stay bound to their owner, table and column. */
function companyAadFor(userId: string, table: string, column: string): string {
  return `company|owner:${userId}|table:${table}|column:${column}`
}

export async function encryptTenantValue(input: {
  userId: string
  table: string
  column: string
  plaintext: string
  scope?: EncryptionScope
}): Promise<string> {
  if (input.scope === 'company') {
    const key = await getOrCreateCompanyDek()
    return encryptEnvelope(input.plaintext, key, companyAadFor(input.userId, input.table, input.column), 'company')
  }
  const { dek } = await getOrCreateTenantDek(input.userId)
  return encryptEnvelope(input.plaintext, dek, aadFor(input.userId, input.table, input.column))
}

/** The key a stored value is sealed with. */
export function ciphertextScope(ciphertext: string): EncryptionScope {
  return envelopeKeyId(ciphertext) === 'company' ? 'company' : 'person'
}

export async function decryptTenantValue(input: {
  userId: string
  table: string
  column: string
  ciphertext: string
}): Promise<string> {
  if (ciphertextScope(input.ciphertext) === 'company') {
    const key = await getOrCreateCompanyDek()
    return decryptEnvelope(input.ciphertext, key, companyAadFor(input.userId, input.table, input.column))
  }
  const sessionUser = tenantUserAsyncLocal.getStore()
  if (sessionUser && sessionUser !== input.userId) {
    // Only the owner's own session holds their key. A row of theirs this
    // session can read must be company-sealed (shared-memory-keys.ts).
    throw new Error(
      `${input.table}.${input.column} of another person is sealed with their own key: it is not shared (re-key missing?)`,
    )
  }
  const { dek } = await getOrCreateTenantDek(input.userId)
  return decryptEnvelope(input.ciphertext, dek, aadFor(input.userId, input.table, input.column))
}
