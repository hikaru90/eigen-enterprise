import type { PrincipalKind } from './types'

export const SYSTEM_PRINCIPAL_ID = 'system'

export type Principal = {
  id: string
  kind: PrincipalKind
  displayName?: string
  roles: string[]
  /** SHA-256 hex hash of the raw API key (see src/lib/server/api-keys/api-key-utils.ts). */
  apiKeyHash?: string | null
}

export type PrincipalStore = {
  getById(id: string): Promise<Principal | null>
  getByApiKey(apiKeyHash: string): Promise<Principal | null>
}

export class PrincipalService {
  constructor(private readonly store: PrincipalStore) {}

  /** `hashedKey` must already be hashed (sha256 hex) by the caller. */
  resolveByApiKey(hashedKey: string): Promise<Principal | null> {
    if (!hashedKey) throw new TypeError('resolveByApiKey requires a hashed key')
    return this.store.getByApiKey(hashedKey)
  }

  resolveById(id: string): Promise<Principal | null> {
    if (!id) throw new TypeError('resolveById requires an id')
    return this.store.getById(id)
  }
}
