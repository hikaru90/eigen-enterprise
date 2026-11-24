import type { PublishPort } from './port'
import { APP_VERSION } from '$lib/app-version'
import { env } from '$lib/server/env/private-env'
import { CORE_API_VERSION } from '../../../contracts/core-api-version'
import { dbShareStore } from '../../contribute/share/db-store'
import { sealedInstallKeyStore } from '../../contribute/share/identity'
import { installKey } from '../../contribute/share/worker'
import { createHubPublishPort, fetchModuleHubTransport } from './client'

/**
 * The live PublishPort: the hub origin from MODULE_HUB_URL (rendered by ee;
 * no default — unset is "module hub not configured"), the install's
 * Contribute key (sealed beside the company root key under TENANT_MASTER_KEY,
 * one identity per install for both hubs), and fetch.
 */

async function identity() {
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { resolveCompanyKeysDir } = await import('$lib/server/gitstore/keys')
  const master = env.TENANT_MASTER_KEY
  if (!master?.trim()) throw new Error('TENANT_MASTER_KEY is required to keep the install key the module hub knows this install by')
  const share = dbShareStore(createScopedDrizzle(appSql))
  const keys = sealedInstallKeyStore(resolveCompanyKeysDir(env), master)
  return installKey({ share, keys, now: () => new Date() }, await share.settings())
}

let port: PublishPort | null = null

export function livePublishPort(): PublishPort {
  port ??= createHubPublishPort({
    hubUrl: () => env.MODULE_HUB_URL,
    identity,
    transport: (origin) => fetchModuleHubTransport(origin),
    appVersion: APP_VERSION,
    coreApi: CORE_API_VERSION,
    now: () => new Date(),
  })
  return port
}
