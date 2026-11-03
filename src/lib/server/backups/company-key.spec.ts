import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveBackupKey, rootKeyFromRecoveryCode } from '$lib/server/gitstore/keys'
import { companyBackupKey } from './company-key'

describe('companyBackupKey', () => {
  it('creates the company root key once, then always returns the same code and derived backup key', async () => {
    const env = { COMPANY_KEYS_DIR: join(await mkdtemp(join(tmpdir(), 'ck-')), 'keys'), TENANT_MASTER_KEY: 'm'.repeat(32) }
    const first = await companyBackupKey(env)
    expect(first.created).toBe(true)
    expect(first.recoveryCode).toMatch(/^EE1-/)
    const again = await companyBackupKey(env)
    expect(again).toEqual({ ...first, created: false })
    // The code alone yields the backup key (what `ee restore` does).
    const root = await rootKeyFromRecoveryCode(first.recoveryCode)
    expect(deriveBackupKey(root.identity).toString('base64')).toBe(first.backupKey)
  })

  it('fails loud without TENANT_MASTER_KEY', async () => {
    await expect(companyBackupKey({ COMPANY_KEYS_DIR: '/nonexistent' })).rejects.toThrow(/TENANT_MASTER_KEY/)
  })
})
