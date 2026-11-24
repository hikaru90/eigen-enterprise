import type { ModuleManifestV1 } from '../../contracts/module-manifest'
import type { ModuleReceiptV1 } from '../../contracts/module-receipt'

/**
 * The box's publish client (plan/phase-upgrades-u2.md §6, §9 Stream C): what
 * `modules.publish` hands the module hub, and the receipt it gets back.
 * Stream C implements it in `modules/company-modules/publish/` (signed
 * requests to `POST /api/hub/modules/publish`); stream A codes against this
 * port and tests with a fake that signs with the fixture test key.
 *
 * Failures are KernelErrors: `hub_unavailable` when the hub can't be reached
 * or `MODULE_HUB_URL` is unset (§6.5, the sentence in its message); the hub's
 * own refusals (409/413/422) with their problems in `details`.
 */
export type PublishRequest = {
  moduleId: string
  version: string
  /** 40 hex. */
  commit: string
  manifest: ModuleManifestV1
  /** The deterministic bundle of `<id>/` at `commit` (§6.1). */
  bundle: Uint8Array
  bundleSha256: string
  /** The box's CORE_API_VERSION. */
  coreApi: string
}

export type PublishPort = {
  publish(request: PublishRequest): Promise<ModuleReceiptV1>
  /**
   * A published bundle's bytes by sha256 (`GET /api/hub/modules/bundles/:sha256`, §3):
   * after a restore whose module repo lacks the commit, the kernel re-fetches it
   * and re-deploys. The caller checks the sha256.
   */
  fetchBundle(bundleSha256: string): Promise<Uint8Array>
}

/** The sentence of §6.5 when the hub is down. */
export const HUB_UNAVAILABLE_SENTENCE =
  "The module hub can't be reached, so new module code can't run yet. Everything already running keeps running."
