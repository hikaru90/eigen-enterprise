import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const env: Record<string, string | undefined> = {}
vi.mock('$lib/server/env/private-env', () => ({ env }))

const { companyExportFiles } = await import('./files')
const { blobPath, diskBlobStore, driveBlobKey, isSealed } = await import('../../../../../modules/drive/storage')

type Row = Record<string, unknown>
function fakeSql(answers: { folders: Row[]; live: Row[]; shas: Row[] }) {
  const sql = (() => Promise.resolve(answers.folders)) as unknown as Record<string, unknown>
  let n = 0
  sql.unsafe = () => Promise.resolve([answers.live, answers.shas][n++] ?? [])
  return sql as never
}

async function text(it: AsyncIterable<Uint8Array>) {
  const parts: Buffer[] = []
  for await (const c of it) parts.push(Buffer.from(c))
  return Buffer.concat(parts).toString('utf8')
}

describe('company export of Drive files (sealed at rest)', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  it('carries the plaintext of sealed blobs (live files and other revisions), so the export opens without the master key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-drive-'))
    dirs.push(dir)
    env.DRIVE_STORAGE_DIR = dir
    env.TENANT_MASTER_KEY = 'export-test-master'
    const blobs = diskBlobStore(dir, driveBlobKey(env))
    const live = await blobs.put(new TextEncoder().encode('current plan'))
    const old = await blobs.put(new TextEncoder().encode('older revision'))
    expect(isSealed(await readFile(blobPath(dir, live.sha256)))).toBe(true)

    const out: Record<string, string> = {}
    for await (const f of companyExportFiles(
      fakeSql({
        folders: [],
        live: [{ id: 'f1', folder_id: null, name: 'plan.md', sha256: live.sha256 }],
        shas: [{ sha256: live.sha256 }, { sha256: old.sha256 }],
      }),
    ))
      if (!f.path.startsWith('blobs/brand') && !f.path.startsWith('blobs/profile') && !f.path.startsWith('blobs/company'))
        out[f.path] = await text(f.open())
    expect(out).toEqual({ 'drive/plan.md': 'current plan', [`blobs/drive/${old.sha256}`]: 'older revision' })
  })

  it('a blob the tables name but the disk lacks stops the export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'export-drive-'))
    dirs.push(dir)
    env.DRIVE_STORAGE_DIR = dir
    env.TENANT_MASTER_KEY = 'export-test-master'
    const it = companyExportFiles(fakeSql({ folders: [], live: [{ id: 'f1', folder_id: null, name: 'x', sha256: 'a'.repeat(64) }], shas: [] }))
    await expect(it[Symbol.asyncIterator]().next()).rejects.toThrow(/missing on disk/)
  })
})
