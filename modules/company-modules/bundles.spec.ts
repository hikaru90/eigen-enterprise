import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryModuleStore } from '$lib/kernel/module-host/memory'
import { helloVersion } from '$lib/kernel/module-host/testing/hello'
import { moduleBundles } from './bundles'
import { ModuleRepo } from './repo'
import { FakePublishPort } from './testing/fake-publish'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bundles-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('moduleBundles (restore: the repo, else the hub, always the receipted bytes)', () => {
  it('re-fetches from the hub by sha256 when the module repo lacks the commit, and checks the bytes', async () => {
    const repo = new ModuleRepo(dir)
    const store = new InMemoryModuleStore()
    const hub = new FakePublishPort()
    const { version, bytes } = await helloVersion('a'.repeat(40))
    await store.addVersion(version)
    const bundles = moduleBundles(repo, store, hub)
    await expect(bundles.bytes('hello', version.commit)).rejects.toThrow(/has no bundle/)
    hub.published.push({ moduleId: 'hello', version: '0.1.0', commit: version.commit, manifest: version.manifest, bundle: bytes, bundleSha256: version.bundleSha256 })
    expect(Buffer.from(await bundles.bytes('hello', version.commit)).equals(bytes)).toBe(true)
    hub.published[0]!.bundle = Buffer.from('tampered')
    await expect(bundles.bytes('hello', version.commit)).rejects.toMatchObject({ code: 'module_unreceipted' })
    await expect(bundles.bytes('hello', 'b'.repeat(40))).rejects.toMatchObject({ code: 'module_unreceipted' })
  })
})
