import type { InstallKeyStore } from './identity'
import type { ShareDeps } from './service'
import { APP_VERSION } from '$lib/app-version'
import { env } from '$lib/server/env/private-env'
import { dbContributeStore } from '../db-store'
import { dbShareStore } from './db-store'
import { fetchHubTransport, hubConfig } from './hub'
import { sealedInstallKeyStore } from './identity'
import { scrubTitle } from './scrub'
import { oneAtATime, runShareTick, type ShareTickResult } from './worker'

/**
 * Live wiring of sharing with the central board: the DB stores over the app
 * pool, the sealed install key beside the company root key (resolved at use:
 * fails loud without COMPANY_KEYS_DIR/EE_STATE_DIR or TENANT_MASTER_KEY), the
 * hub origin from CONTRIBUTE_HUB_URL (no default), and the scrub through the
 * gateway on the company's AI provider (the owner's), attributed to the owner.
 */

/** The central board itself (contribute-hub active) does not send to itself (plan §3). */
export const HUB_MODULE_ID = 'contribute-hub'

const keys: InstallKeyStore = {
  async load() {
    return (await keyStore()).load()
  },
  async save(key) {
    return (await keyStore()).save(key)
  },
}

async function keyStore(): Promise<InstallKeyStore> {
  const { resolveCompanyKeysDir } = await import('$lib/server/gitstore/keys')
  const master = env.TENANT_MASTER_KEY
  if (!master?.trim()) throw new Error('TENANT_MASTER_KEY is required to keep the Contribute install key')
  return sealedInstallKeyStore(resolveCompanyKeysDir(env), master)
}

async function scrub(title: string) {
  const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
  const { companyOwnerId, onCompanyProvider } = await import('$lib/server/llm/company-provider')
  return onCompanyProvider(async () => {
    const owner = await companyOwnerId()
    if (!owner) throw new Error('the company has no owner')
    return scrubTitle((input) => llmChatCompletion(input), { userId: owner, title })
  })
}

let depsPromise: Promise<ShareDeps> | null = null

export function shareDeps(): Promise<ShareDeps> {
  depsPromise ??= (async (): Promise<ShareDeps> => {
    const { appSql, createScopedDrizzle } = await import('$lib/server/db')
    const db = createScopedDrizzle(appSql)
    return {
      share: dbShareStore(db),
      contributions: dbContributeStore(db),
      keys,
      hub: () => hubConfig(env.CONTRIBUTE_HUB_URL),
      transport: (origin) => fetchHubTransport(origin),
      scrub,
      appVersion: APP_VERSION,
      now: () => new Date(),
      providerReady: async () => (await import('$lib/server/llm/provider-ready')).isCompanyProviderReady(),
    }
  })().catch((err) => {
    depsPromise = null
    throw err
  })
  return depsPromise
}

/** Whether this install is the central board (then it shares nothing). */
export async function isHubInstall(): Promise<boolean> {
  const { appKernel } = await import('$lib/server/boot')
  const kernel = await appKernel()
  return kernel.activations.get(HUB_MODULE_ID)
}

/** One pass for the job-queue tick (and the e2e harness trigger); one at a time per process. */
export const shareTick: () => Promise<ShareTickResult | null> = oneAtATime(async () => {
  if (await isHubInstall()) return null
  const out = await runShareTick(await shareDeps())
  if (out.claimed > 0) console.info('[contribute.share] tick', out)
  return out
})
