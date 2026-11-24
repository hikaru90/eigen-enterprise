import type { HubSigner } from '../../../../modules/company-modules/publish/client'
import type { PublishPort } from '../../../../modules/company-modules/publish/port'
import type { InstallKey } from '../../../../modules/contribute/share/identity'
import { APP_VERSION } from '$lib/app-version'
import { env } from '$lib/server/env/private-env'
import { CORE_API_VERSION } from '../../../../contracts/core-api-version'
import { createHubPublishPort, fetchModuleHubTransport } from '../../../../modules/company-modules/publish/client'
import { hubRegisterV1, signHubRequest } from '../../../../modules/contribute/share/contract'

/**
 * The live PublishPort of a box (plan/phase-upgrades-u2.md §6, §8), composed
 * here — outside both modules — from the company-modules publish client and
 * the Contribute install identity: the hub origin from MODULE_HUB_URL
 * (rendered by ee; no default — unset is "module hub not configured"), the
 * install's Contribute key (sealed beside the company root key under
 * TENANT_MASTER_KEY; one identity per install for both hubs), and fetch.
 */

/** A signer over an install key, with the contribute hub's own request signing and register schema. */
export function installSigner(key: InstallKey): HubSigner {
  return {
    installId: key.installId,
    sign: ({ method, path, body, now }) => signHubRequest({ method, path, body, installId: key.installId, privateKey: key.privateKey, now }),
    registerBody: (appVersion) =>
      JSON.stringify(hubRegisterV1.parse({ v: 1, install_id: key.installId, public_key: key.publicKey, app_version: appVersion })),
  }
}

async function identity(): Promise<HubSigner> {
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const { resolveCompanyKeysDir } = await import('$lib/server/gitstore/keys')
  const { dbShareStore } = await import('../../../../modules/contribute/share/db-store')
  const { sealedInstallKeyStore } = await import('../../../../modules/contribute/share/identity')
  const { installKey } = await import('../../../../modules/contribute/share/worker')
  const master = env.TENANT_MASTER_KEY
  if (!master?.trim()) throw new Error('TENANT_MASTER_KEY is required to keep the install key the module hub knows this install by')
  const share = dbShareStore(createScopedDrizzle(appSql))
  const keys = sealedInstallKeyStore(resolveCompanyKeysDir(env), master)
  return installSigner(await installKey({ share, keys, now: () => new Date() }, await share.settings()))
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
