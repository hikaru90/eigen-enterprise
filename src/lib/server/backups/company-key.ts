import { rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  deriveBackupKey,
  generateRootKey,
  recoveryCodeFromIdentity,
  resolveCompanyKeysDir,
  rootKeyFromRecoveryCode,
  SealedRootKeyStore,
} from '$lib/server/gitstore/keys'

/**
 * The ONE company recovery code (plan/phase-git-native.md §3) also opens the
 * backups: the backup key is derived from the company root key. This loads the
 * sealed root key, or creates it (gitstore's key setup) when the company has
 * none yet. Only the derived backup key ever goes to ee — never the root key.
 */
export type BackupKeyMaterial = { backupKey: string; recoveryCode: string; created: boolean }

export async function companyBackupKey(env: NodeJS.ProcessEnv = process.env): Promise<BackupKeyMaterial> {
  const master = env.TENANT_MASTER_KEY
  if (!master?.trim()) throw new Error('TENANT_MASTER_KEY is required to unseal the company root key')
  const store = new SealedRootKeyStore(resolveCompanyKeysDir(env), master)
  let identity = (await store.load())?.identity
  let created = false
  if (!identity) {
    const fresh = await generateRootKey()
    await store.save(fresh)
    identity = fresh.identity
    created = true
  }
  return {
    backupKey: deriveBackupKey(identity).toString('base64'),
    recoveryCode: recoveryCodeFromIdentity(identity),
    created,
  }
}

/**
 * The backup key (base64) from a recovery code the owner typed to restore a
 * backup — what `ee restore` derives from the code it asks for. Throws
 * CompanyKeyError (typo, wrong length) with a plain message. The code itself
 * goes nowhere: only the derived key is handed to ee, which checks it against
 * the key it holds.
 */
export async function backupKeyFromRecoveryCode(code: string): Promise<string> {
  const { identity } = await rootKeyFromRecoveryCode(code)
  return deriveBackupKey(identity).toString('base64')
}

/**
 * When the box got its backup key from os without the owner (managed mode,
 * /api/fleet/backup-key) and that created the company root key, the owner has
 * never seen the recovery code. A marker file beside the sealed root key says
 * so: company-level key state already lives there, so no table. It holds no
 * secret; the code is re-derived from the sealed key when it is shown.
 */
const PENDING_MARKER = 'recovery-code-pending'

export async function markRecoveryCodePending(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await writeFile(join(resolveCompanyKeysDir(env), PENDING_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 })
}

/** The recovery code the owner has not seen yet, once: taking it marks it shown. Null when none is pending. */
export async function takePendingRecoveryCode(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const marker = join(resolveCompanyKeysDir(env), PENDING_MARKER)
  try {
    await stat(marker)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const { recoveryCode } = await companyBackupKey(env)
  await rm(marker)
  return recoveryCode
}
