import { PATHS } from './paths.ts'
import type { SecretAccess } from './reconcile.ts'
import { decryptSecrets, encryptSecrets, type SecretMap } from './secrets.ts'
import type { System } from './system.ts'

/** File-backed secret store under the host key (D9). Loaded once; every set re-encrypts atomically. */
export class SecretStore implements SecretAccess {
  private data: SecretMap = {}

  private constructor(
    private readonly sys: System,
    private readonly key: Buffer,
  ) {}

  static async open(sys: System): Promise<SecretStore> {
    const keyB64 = await sys.readFile(PATHS.masterKey)
    if (keyB64 === null) throw new Error(`host key ${PATHS.masterKey} is missing — run \`ee bootstrap\``)
    const store = new SecretStore(sys, Buffer.from(keyB64.trim(), 'base64'))
    const blob = await sys.readFile(PATHS.secrets)
    store.data = blob === null ? {} : decryptSecrets(store.key, blob)
    return store
  }

  all(): SecretMap {
    return this.data
  }

  async set(workload: string, name: string, value: string): Promise<void> {
    this.data = { ...this.data, [workload]: { ...(this.data[workload] ?? {}), [name]: value } }
    await this.sys.writeFile(PATHS.secrets, encryptSecrets(this.key, this.data), 0o600)
  }
}
