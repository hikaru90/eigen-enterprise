import type { ModuleHubDeps } from '../../../../modules/module-hub/service'
import { MODULE_HUB_PATHS } from '$lib/module-hub/contract'
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
} from '../../../../contracts/fixtures/module-hub-test-key'
import { authenticate, register } from '../../../../modules/contribute/hub/service'
import { fixture as contributeHubFixture, registerBody, signed, type TestInstall } from '../../../../modules/contribute/hub/test-fixtures'
import { memoryBundleStorage } from '../../../../modules/module-hub/bundles'
import { lockCatalog } from '../../../../modules/module-hub/checks'
import { memoryModuleHubStore } from '../../../../modules/module-hub/memory-store'

/**
 * The composed module hub for specs: the module-hub service over memory
 * stores, authenticated by the contribute hub's real signature check, replay
 * guard, revocation and rate limit (the composition of http.ts), with the
 * TEST-ONLY receipt key.
 */
export function composedModuleHubFixture() {
  const base = contributeHubFixture()
  const store = memoryModuleHubStore(base.store.installs)
  const bundles = memoryBundleStorage()
  const summaries: string[] = []
  const deps: ModuleHubDeps = {
    authenticate: (req) => authenticate(base.deps, req),
    now: base.deps.now,
    store,
    bundles,
    signingKey: () => TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
    origin: () => TEST_ONLY_MODULE_HUB_ORIGIN,
    catalog: lockCatalog(),
    enqueueSummary: async (sha) => {
      summaries.push(sha)
    },
  }
  /** A signed request at the current clock; each call is a new signature (+1 ms). */
  const req = (i: TestInstall, method: string, path: string, body: string) => {
    base.clock.now += 1
    return signed(i, method, path, body, base.clock.now)
  }
  const publishReq = (i: TestInstall, body: string) => req(i, 'POST', MODULE_HUB_PATHS.publish, body)
  const registered = async (i: TestInstall) => {
    await register(base.deps, registerBody(i))
    return i
  }
  return { ...base, hubDeps: base.deps, moduleStore: store, bundles, summaries, deps, req, publishReq, registered }
}
