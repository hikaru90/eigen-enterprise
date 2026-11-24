import { CORE_API_VERSION } from '../../../contracts/core-api-version'
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
} from '../../../contracts/fixtures/module-hub-test-key'
import { readBundle, sha256Hex } from '../../../contracts/module-bundle'
import { manifestSha256 } from '../../../contracts/module-manifest'
import { signReceipt, type ModuleReceiptV1 } from '../../../contracts/module-receipt'
import { KernelError } from '$lib/kernel/errors'
import { HUB_UNAVAILABLE_SENTENCE, type PublishPort, type PublishRequest } from '../ports'

/**
 * TEST ONLY — a module hub that signs receipts with the public fixture key
 * (plan/phase-upgrades-u2.md §9 Stream A). It checks what the real hub checks
 * first (the bundle parses and matches its sha256), answers the same receipt
 * for the same bundle, refuses the same commit with another bundle (409), and
 * can be switched off (`hub_unavailable`).
 */
export class FakePublishPort implements PublishPort {
  readonly published: PublishRequest[] = []
  private readonly receipts = new Map<string, ModuleReceiptV1>()
  down = false

  constructor(private readonly installId = 'test-install') {}

  async publish(request: PublishRequest): Promise<ModuleReceiptV1> {
    if (this.down) throw new KernelError('hub_unavailable', HUB_UNAVAILABLE_SENTENCE)
    if (sha256Hex(request.bundle) !== request.bundleSha256) {
      throw new KernelError('invalid_input', 'the bundle does not match its sha256')
    }
    readBundle(request.bundle)
    const key = `${request.moduleId}@${request.commit}`
    const existing = this.receipts.get(key)
    if (existing) {
      if (existing.bundleSha256 !== request.bundleSha256) {
        throw new KernelError('invalid_input', `${key} was published with another bundle (409)`)
      }
      return existing
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
    return receipt
  }

  async fetchBundle(bundleSha256: string): Promise<Uint8Array> {
    if (this.down) throw new KernelError('hub_unavailable', HUB_UNAVAILABLE_SENTENCE)
    const found = this.published.find((p) => p.bundleSha256 === bundleSha256)
    if (!found) throw new KernelError('invalid_input', `the hub has no bundle ${bundleSha256}`)
    return found.bundle
  }
}
