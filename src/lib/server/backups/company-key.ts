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
