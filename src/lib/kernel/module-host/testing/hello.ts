import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE_API_VERSION } from '../../../../../contracts/core-api-version'
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
} from '../../../../../contracts/fixtures/module-hub-test-key'
import { createBundle, type BundleFile } from '../../../../../contracts/module-bundle'
import {
  manifestSha256,
  parseModuleManifest,
  parseModuleManifestYaml,
  type ModuleManifestV1,
} from '../../../../../contracts/module-manifest'
import { signReceipt, type ModuleReceiptV1 } from '../../../../../contracts/module-receipt'
import type { PublishedVersion } from '../types'

/**
 * TEST ONLY — the U2 fixture module `hello` (contracts/fixtures/modules/hello)
 * as specs need it: its files, a bundle of them, and receipts signed with the
 * public test hub key (never trusted anywhere real).
 */

export const HELLO_DIR = fileURLToPath(new URL('../../../../../contracts/fixtures/modules/hello', import.meta.url))

export async function helloFiles(): Promise<BundleFile[]> {
  const out: BundleFile[] = []
  for (const name of (await readdir(HELLO_DIR)).sort()) {
    out.push({ path: name, content: await readFile(join(HELLO_DIR, name)) })
  }
  return out
}

export async function helloManifest(): Promise<ModuleManifestV1> {
  return parseModuleManifestYaml(await readFile(join(HELLO_DIR, 'module.yaml'), 'utf8'))
}

/** A receipt the fixture hub key signs (what a hub would answer to a publish). */
export function testReceipt(input: {
  manifest: ModuleManifestV1
  commit: string
  bundleSha256: string
  installId?: string
}): ModuleReceiptV1 {
  return signReceipt(
    {
      hub: TEST_ONLY_MODULE_HUB_ORIGIN,
      installId: input.installId ?? 'test-install',
      moduleId: input.manifest.id,
      version: input.manifest.version,
      commit: input.commit,
      bundleSha256: input.bundleSha256,
      manifestSha256: manifestSha256(input.manifest),
      coreApi: CORE_API_VERSION,
      license: 'Apache-2.0',
      deprecatedUses: [],
      issuedAt: new Date().toISOString(),
    },
    TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
  )
}

/**
 * A published version of hello (or of a manifest derived from it) at `commit`,
 * with its bundle bytes — files changed by `extra` make another bundle.
 */
export async function helloVersion(
  commit: string,
  options: { manifest?: (m: ModuleManifestV1) => unknown; extra?: BundleFile[] } = {},
): Promise<{ version: PublishedVersion; bytes: Buffer }> {
  const base = await helloManifest()
  const manifest = options.manifest ? parseModuleManifest(options.manifest(structuredClone(base))) : base
  const files = [...(await helloFiles()), ...(options.extra ?? [])]
  const { bytes, sha256 } = createBundle(files, new Date('2026-11-24T12:00:00Z'))
  const receipt = testReceipt({ manifest, commit, bundleSha256: sha256 })
  return {
    version: {
      moduleId: manifest.id,
      commit,
      version: manifest.version,
      bundleSha256: sha256,
      manifest,
      receipt,
      publishedAt: receipt.issuedAt,
    },
    bytes,
  }
}
