import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getKekKeyId, getKekProvider, unwrapCompanyDek, wrapCompanyDek } from '$lib/server/crypto/kms'
import { getDb } from '$lib/server/db'
import { companyDataKey } from '$lib/server/db/schema'

/**
 * The company's data key (drizzle/0164): the one key every signed-in member's
 * session can use, for Memory rows shared with the whole company (a shared
 * project's tasks, shared notes). Created on first use; never rotated by the
 * app. Private rows keep their owner's tenant DEK (tenant-keys.ts).
 */
const COMPANY_ROW_ID = 'company'
const DEK_CACHE_TTL_MS = 5 * 60 * 1000
let cached: { key: Buffer; expiresAt: number } | null = null
let pending: Promise<Buffer> | null = null

async function readRow() {
  const [row] = await getDb()
    .select()
    .from(companyDataKey)
    .where(eq(companyDataKey.id, COMPANY_ROW_ID))
    .limit(1)
  return row
}

async function loadOrCreate(): Promise<Buffer> {
  let row = await readRow()
  if (!row) {
    await getDb()
      .insert(companyDataKey)
      .values({
        id: COMPANY_ROW_ID,
        wrappedDek: await wrapCompanyDek(randomBytes(32)),
        kekProvider: getKekProvider(),
        kekKeyId: getKekKeyId(),
      })
      .onConflictDoNothing()
    row = await readRow()
  }
  if (!row) {
    throw new Error('company_data_key is not readable: the company key needs a signed-in member’s session')
  }
  return unwrapCompanyDek(row.wrappedDek)
}

export async function getOrCreateCompanyDek(): Promise<Buffer> {
  if (cached && cached.expiresAt > Date.now()) return cached.key
  if (!pending) {
    pending = loadOrCreate()
      .then((key) => {
        cached = { key, expiresAt: Date.now() + DEK_CACHE_TTL_MS }
        return key
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}
