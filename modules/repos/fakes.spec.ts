import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { gitBlobSha } from '$lib/server/github/git'
import { readTarGz } from '$lib/server/github/tar'
import { REPOS_DRIVE_SOURCE as SRC } from './manifest'
import { TOKEN, setup } from './test-setup'
import { FakeDrivePort, FakeGitHub, sampleRepo } from './testing'

/**
 * The full-mirror fakes, pinned themselves (the coverage M1's worktree
 * deleted with src/lib/server/github/full-mirror-fakes.spec.ts): what the
 * fake GitHub serves through blobBytes/tarball, and what the fake Drive port
 * promises (atomic batches, prefix-scoped listing).
 */

describe('FakeGitHub.blobBytes and tarball (the fake is honest)', () => {
  it('returns a blob’s exact bytes, as a Uint8Array and never a Buffer', async () => {
    const t = setup()
    const entry = t.data.tree!.entries.find((e) => e.path === 'assets/logo.png')!
    const bytes = await t.deps.client(TOKEN).blobBytes('kindred/shop', entry.sha)
    expect([...bytes]).toEqual([...t.data.blobs![entry.sha]!])
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).not.toBeInstanceOf(Buffer)
    await expect(t.deps.client(TOKEN).blobBytes('kindred/shop', 'missing-sha')).rejects.toThrow('fake blob missing-sha missing')
  })

  it('builds a real gzipped tarball: every regular blob of the repo, under <owner>-<repo>-<sha>/', async () => {
    const t = setup()
    const head = 'a1'.padEnd(40, '0')
    const path = await t.deps.client(TOKEN).tarball('kindred/shop', head)
    try {
      const entries: Array<{ path: string; bytes: Uint8Array }> = []
      for await (const e of readTarGz(path)) entries.push({ path: e.path, bytes: e.bytes })
      const top = `kindred-shop-${head}`
      // Like codeload's: every regular file of the commit — the LFS pointer and
      // the backslash path included (the sync's pick logic skips those); the
      // symlink and the submodule gitlink never enter an archive, and the
      // over-size entry has no real blob to serve.
      expect(entries.map((e) => e.path).sort()).toEqual(
        ['README.md', 'assets/logo.png', 'assets/video.mp4', 'docs/guide/intro.mdx', 'docs/huge.md', 'docs/weird\\name.md', 'package.json', 'src/index.ts', 'src/util/format.ts']
          .map((p) => `${top}/${p}`)
          .sort(),
      )
      // The bytes round-trip through gzip and tar, and each keeps its git blob sha.
      for (const e of entries) {
        const pathPart = e.path.slice(top.length + 1)
        const entry = t.data.tree!.entries.find((x) => x.path === pathPart)!
        expect(gitBlobSha(e.bytes)).toBe(entry.sha)
      }
    } finally {
      await rm(path, { force: true })
    }
  })

  it('counts one tarball request against the budget, like any other call', async () => {
    const gh = new FakeGitHub()
    gh.identities.set(TOKEN, { login: 'ada', expiresAt: null, classic: false })
    gh.addRepo(sampleRepo(), [TOKEN])
    const client = gh.client(TOKEN)
    const before = (await client.identity()).budget.remaining
    await client.tarball('kindred/shop', 'a1'.padEnd(40, '0'))
    await client.repo('kindred/shop', null)
    expect(client.lastBudget()!.remaining).toBe(before - 2) // identity + tarball + repo each cost 1
  })
})

describe('FakeDrivePort (the port contract, in memory)', () => {
  it('upsertBytes/upsertMany roll back the whole batch when a parent is missing', async () => {
    const drive = new FakeDrivePort()
    await drive.ensureRoot(SRC, 'GitHub')
    await drive.upsertFolder(SRC, 'repo:1', null, 'shop')
    await expect(drive.upsertBytes(SRC, 'repo:1/tree/a.ts', 'no-such-parent', 'a.ts', new Uint8Array(1), 'text/plain')).rejects.toThrow(
      'parent no-such-parent missing',
    )
    expect(drive.file(SRC, 'repo:1/tree/a.ts')).toBeUndefined()
    await expect(
      drive.upsertMany(SRC, [
        { kind: 'folder', key: 'repo:1/tree', parentKey: 'repo:1', name: 'main' },
        { kind: 'bytes', key: 'repo:1/tree/a.ts', parentKey: 'repo:1/tree', name: 'a.ts', bytes: new Uint8Array([1]), mime: 'text/plain' },
        { kind: 'bytes', key: 'repo:1/tree/b.ts', parentKey: 'gone', name: 'b.ts', bytes: new Uint8Array([2]), mime: 'text/plain' },
      ]),
    ).rejects.toThrow('parent gone missing')
    // Nothing of the batch landed: no items, no ids handed out, no writes logged.
    expect(drive.file(SRC, 'repo:1/tree')).toBeUndefined()
    expect(drive.file(SRC, 'repo:1/tree/a.ts')).toBeUndefined()
    expect(drive.calls.filter((c) => c.op !== 'upsertFolder' || c.key !== 'repo:1')).toEqual([])
    expect(drive.writes).toBe(0)
  })

  it('list(keyPrefix) returns exactly the item at the prefix and its descendants', async () => {
    const drive = new FakeDrivePort()
    await drive.ensureRoot(SRC, 'GitHub')
    await drive.upsertFolder(SRC, 'repo:1', null, 'shop')
    await drive.upsertText(SRC, 'repo:1/Overview.md', 'repo:1', 'Overview.md', '# one')
    await drive.upsertFolder(SRC, 'repo:1/tree', 'repo:1', 'main')
    await drive.upsertText(SRC, 'repo:1/tree/a.ts', 'repo:1/tree', 'a.ts', '1')
    await drive.upsertFolder(SRC, 'repo:2', null, 'other')
    expect((await drive.list(SRC, 'repo:1/tree')).map((i) => i.key)).toEqual(['repo:1/tree', 'repo:1/tree/a.ts'])
    expect((await drive.list(SRC, 'repo:1')).map((i) => i.key)).toEqual(['repo:1', 'repo:1/Overview.md', 'repo:1/tree', 'repo:1/tree/a.ts'])
    expect((await drive.list(SRC)).map((i) => i.key)).toContain('repo:2')
    expect(await drive.list(SRC, 'repo:9')).toEqual([])
  })
})
