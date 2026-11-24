import type { ModuleHubDeps, ModuleHubRequest } from './service'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { CORE_API_VERSION } from '../../contracts/core-api-version'
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
} from '../../contracts/fixtures/module-hub-test-key'
import { createBundle, sha256Hex, type BundleFile } from '../../contracts/module-bundle'
import { parseModuleManifestYaml } from '../../contracts/module-manifest'
import { MODULE_HUB_PATHS, type HubModulePublishV1 } from '../../src/lib/module-hub/contract'
import { memoryBundleStorage } from './bundles'
import { lockCatalog, type HubCatalog } from './checks'
import { memoryModuleHubStore } from './memory-store'

/** The contract's hello fixture module (contracts/fixtures/modules/hello). */
export const HELLO_DIR = join(import.meta.dirname, '../../contracts/fixtures/modules/hello')
export const COMMIT_TIME = new Date('2026-11-24T09:00:00Z')
export const COMMIT_A = 'a'.repeat(40)
export const COMMIT_B = 'b'.repeat(40)

/** The hello folder's files, editable per spec. */
export function helloFiles(): BundleFile[] {
  return readdirSync(HELLO_DIR)
    .sort()
    .map((name) => ({ path: name, content: new Uint8Array(readFileSync(join(HELLO_DIR, name))) }))
}

export function helloYaml(): string {
  return readFileSync(join(HELLO_DIR, 'module.yaml'), 'utf8')
}

/** A bundle of `files`, with its manifest parsed from their module.yaml. */
export function bundleOf(files: BundleFile[] = helloFiles(), time = COMMIT_TIME) {
  const { bytes, sha256 } = createBundle(files, time)
  const yaml = new TextDecoder().decode(files.find((f) => f.path === 'module.yaml')!.content)
  return { bytes, sha256, manifest: JSON.parse(JSON.stringify(parseModuleManifestYaml(yaml))) as Record<string, unknown> }
}

/**
 * A bundle the hub must refuse but createBundle would never write: the bytes
 * of a valid one with one entry renamed in place (same length, checksum fixed).
 */
export function renamedEntryBundle(from: string, to: string) {
  if (from.length !== to.length) throw new Error('renamedEntryBundle keeps the name length')
  const good = bundleOf()
  const tar = Buffer.from(gunzipSync(good.bytes))
  for (let at = 0; at + 512 <= tar.byteLength; at += 512) {
    if (tar.subarray(at, at + from.length + 1).equals(Buffer.from(`${from}\0`))) {
      tar.write(to, at, 'utf8')
      tar.write('        ', at + 148, 'latin1')
      const sum = tar.subarray(at, at + 512).reduce((s, b) => s + b, 0)
      tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, at + 148, 'latin1')
      const bytes = gzipSync(tar)
      return { bytes, sha256: sha256Hex(bytes), manifest: good.manifest }
    }
  }
  throw new Error(`no entry ${from} in the hello bundle`)
}

/** Replaces (or adds) one file. */
export function withFile(files: BundleFile[], path: string, text: string): BundleFile[] {
  const content = new TextEncoder().encode(text)
  return [...files.filter((f) => f.path !== path), { path, content }]
}

export function publishBody(b: { bytes: Uint8Array; sha256: string; manifest: Record<string, unknown> }, over: Partial<HubModulePublishV1> & Record<string, unknown> = {}) {
  return JSON.stringify({
    v: 1,
    module_id: b.manifest.id,
    version: b.manifest.version,
    commit: COMMIT_A,
    bundle_sha256: b.sha256,
    manifest: b.manifest,
    bundle_b64: Buffer.from(b.bytes).toString('base64'),
    core_api: CORE_API_VERSION,
    app_version: '0.6.0',
    ...over,
  })
}

/** A caller in the module's own specs: an install id the stub authentication trusts. */
export type TestCaller = { installId: string }

/** The header the stub authentication reads (the real one is the contribute hub's signature check). */
export const TEST_CALLER_HEADER = 'x-test-install'

export const T0 = Date.parse('2026-11-24T10:00:00Z')

/**
 * An in-memory module hub with the TEST-ONLY receipt key and a clock the spec
 * moves. Authentication is a stub here (the module imports no other); the
 * composed hub with the contribute hub's real signature check, replay guard
 * and revocation is src/lib/server/module-hub/test-fixtures.ts.
 */
export function moduleHubFixture(opts: { catalog?: HubCatalog } = {}) {
  const installs = new Map<string, { revokedAt: Date | null }>()
  const clock = { now: T0 }
  const store = memoryModuleHubStore(installs)
  const bundles = memoryBundleStorage()
  const summaries: string[] = []
  const deps: ModuleHubDeps = {
    authenticate: async (req) => {
      const installId = req.headers.get(TEST_CALLER_HEADER)
      if (!installId || !installs.has(installId)) throw new Error('stub authentication: unknown install')
      return { installId }
    },
    now: () => clock.now,
    store,
    bundles,
    signingKey: () => TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
    origin: () => TEST_ONLY_MODULE_HUB_ORIGIN,
    catalog: opts.catalog ?? lockCatalog(),
    enqueueSummary: async (sha) => {
      summaries.push(sha)
    },
  }
  const req = (i: TestCaller, method: string, path: string, body: string): ModuleHubRequest => {
    clock.now += 1
    return { method, path, body, headers: new Headers({ [TEST_CALLER_HEADER]: i.installId, 'content-type': 'application/json' }) }
  }
  const publishReq = (i: TestCaller, body: string) => req(i, 'POST', MODULE_HUB_PATHS.publish, body)
  const registered = async (): Promise<TestCaller> => {
    const installId = randomUUID()
    installs.set(installId, { revokedAt: null })
    return { installId }
  }
  const revoke = (installId: string) => installs.set(installId, { revokedAt: new Date(clock.now) })
  return { installs, clock, moduleStore: store, bundles, summaries, deps, req, publishReq, registered, revoke }
}
