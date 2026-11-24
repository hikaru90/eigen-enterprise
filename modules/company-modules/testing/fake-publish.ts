import { CORE_API_VERSION } from '../../../contracts/core-api-version'
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
} from '../../../contracts/fixtures/module-hub-test-key'
import { readBundle, sha256Hex } from '../../../contracts/module-bundle'
import { manifestSha256 } from '../../../contracts/module-manifest'
import { signReceipt, type ModuleReceiptV1 } from '../../../contracts/module-receipt'
import type { HubRunAnswer } from '$lib/module-hub/contract'
import {
  HUB_UNAVAILABLE_SENTENCE,
  PublishPortError,
  type PublishOutcome,
  type PublishPort,
  type PublishRequest,
  type RunReport,
} from '../publish/port'

/**
 * TEST ONLY — a module hub that signs receipts with the public fixture key
 * (plan/phase-upgrades-u2.md §9 Stream A), behind stream C's PublishPort.
 * It checks the bundle parses and matches its sha256, answers the same
 * receipt for the same bundle (created: false), refuses the same commit with
 * another bundle (hub_refused, 409), can be switched off (hub_unavailable),
 * and serves published bundles by sha256.
 */
export class FakePublishPort implements PublishPort {
  readonly published: PublishRequest[] = []
  readonly runs: RunReport[] = []
  private readonly receipts = new Map<string, ModuleReceiptV1>()
  down = false

  constructor(private readonly installId = 'test-install') {}

  async publish(request: PublishRequest): Promise<PublishOutcome> {
    if (this.down) throw new PublishPortError('hub_unavailable', HUB_UNAVAILABLE_SENTENCE, { reason: 'unreachable' })
    if (sha256Hex(request.bundle) !== request.bundleSha256) {
      throw new PublishPortError('hub_refused', 'the bundle does not match its sha256', { status: 422 })
    }
    readBundle(request.bundle)
    const key = `${request.moduleId}@${request.commit}`
    const existing = this.receipts.get(key)
    if (existing) {
      if (existing.bundleSha256 !== request.bundleSha256) {
        throw new PublishPortError('hub_refused', `${key} was published with another bundle`, { status: 409 })
      }
      return { receipt: existing, created: false }
    }
    const receipt = signReceipt(
      {
        hub: TEST_ONLY_MODULE_HUB_ORIGIN,
        installId: this.installId,
        moduleId: request.moduleId,
        version: request.version,
        commit: request.commit,
        bundleSha256: request.bundleSha256,
        manifestSha256: manifestSha256(request.manifest),
        coreApi: CORE_API_VERSION,
        license: 'Apache-2.0',
        deprecatedUses: [],
        issuedAt: new Date().toISOString(),
      },
      TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
    )
    this.receipts.set(key, receipt)
    this.published.push(request)
    return { receipt, created: true }
  }

  async reportRun(report: RunReport): Promise<HubRunAnswer> {
    if (this.down) throw new PublishPortError('hub_unavailable', HUB_UNAVAILABLE_SENTENCE, { reason: 'unreachable' })
    this.runs.push(report)
    return { module_id: report.moduleId, runs: [] }
  }

  async fetchBundle(bundleSha256: string): Promise<Uint8Array> {
    if (this.down) throw new PublishPortError('hub_unavailable', HUB_UNAVAILABLE_SENTENCE, { reason: 'unreachable' })
    const found = this.published.find((p) => p.bundleSha256 === bundleSha256)
    if (!found) throw new PublishPortError('hub_not_found', `the hub has no bundle ${bundleSha256}`, { status: 404 })
    return found.bundle
  }
}
