import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import { decryptStream, encryptStream } from './crypto.ts'
import { S3Error, type S3Client } from './s3.ts'

/**
 * One snapshot (plan/phase-backups.md §2):
 *   <prefix>/snapshots/<id>/{db.dump, ee-state.tar.gz, agent.sqlite, manifest.json}
 *   <prefix>/blobs/<sha256>          (Drive blobs, uploaded once, shared)
 * Every object is EEBK v1 encrypted. The manifest is written LAST: a snapshot
 * without one is incomplete and is never restored from.
 */

export type BackupSources = {
  /** argv that writes a pg_dump custom-format dump of the company DB to stdout. */
  dbDump: string[]
  /** Drive storage root (blobs live at <driveDir>/blobs/<aa>/<bb>/<sha256>). */
  driveDir: string
  /** The agent's durable SQLite file. */
  agentDb: string
  /** ee's own state: absolute paths archived as one tar (company repo, sealed secret store, host key). */
  eeState: string[]
  /** Root-only scratch directory for one run. */
  tmpDir: string
}

export const SNAPSHOT_FILES = ['db.dump', 'ee-state.tar.gz', 'agent.sqlite'] as const
export type SnapshotFile = (typeof SNAPSHOT_FILES)[number]

const fileEntry = z.object({ name: z.enum(SNAPSHOT_FILES), size: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })
export const manifestSchema = z.object({
  format: z.literal('ee-backup-manifest'),
  version: z.literal(1),
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  files: z.array(fileEntry),
  /** Sources that did not exist at backup time (e.g. the agent never ran). */
  absent: z.array(z.enum(SNAPSHOT_FILES)).default([]),
  blobs: z.array(z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int() })),
})
export type Manifest = z.infer<typeof manifestSchema>

const SHA = /^[0-9a-f]{64}$/

export function snapshotId(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}
/** 20261103T031700Z → Date */
export function snapshotDate(id: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(id)
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null
}

/** Run a command with stdout streamed into a file; fails with its stderr. */
export async function runToFile(argv: string[], file: string, opts: { stdinFile?: string } = {}): Promise<void> {
  const [cmd, ...args] = argv
  if (!cmd) throw new Error('empty argv')
  const child = spawn(cmd, args, { stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.on('data', (d) => (stderr = (stderr + String(d)).slice(-4000)))
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`${cmd}: ${err.message}`)))
    child.on('close', (code) => resolve(code ?? 1))
  })
  const fed = opts.stdinFile ? pipeline(createReadStream(opts.stdinFile), child.stdin!) : Promise.resolve()
  const [, , code] = await Promise.all([pipeline(child.stdout!, createWriteStream(file, { mode: 0o600 })), fed.catch(() => undefined), exited])
  if (code !== 0) throw new Error(`${argv.join(' ')} failed (exit ${code}): ${stderr.trim()}`)
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256')
  let size = 0
  for await (const c of createReadStream(path)) {
    h.update(c as Buffer)
    size += (c as Buffer).length
  }
  return { sha256: h.digest('hex'), size }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

/** SQLite's online backup API (consistent while the agent writes), never a raw copy. */
export async function sqliteBackup(src: string, dest: string): Promise<void> {
  const sqlite = (await import('node:sqlite')) as unknown as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { close(): void }
    backup?: (db: unknown, path: string) => Promise<number>
  }
  if (typeof sqlite.backup !== 'function') {
    throw new Error(`this Node (${process.version}) has no node:sqlite backup(); ee needs Node ≥22.16 to back up agent.sqlite safely`)
  }
  const db = new sqlite.DatabaseSync(src, { readOnly: true })
  try {
    await sqlite.backup(db, dest)
  } finally {
    db.close()
  }
}

/** Every Drive blob on disk: <driveDir>/blobs/<aa>/<bb>/<sha256>. */
export async function listDriveBlobs(driveDir: string): Promise<Array<{ sha256: string; path: string; size: number }>> {
  const root = join(driveDir, 'blobs')
  if (!(await exists(root))) return []
  const out: Array<{ sha256: string; path: string; size: number }> = []
  for (const a of await readdir(root)) {
    for (const b of await readdir(join(root, a)).catch(() => [] as string[])) {
      for (const name of await readdir(join(root, a, b)).catch(() => [] as string[])) {
        if (!SHA.test(name) || name.slice(0, 2) !== a || name.slice(2, 4) !== b) continue
        const path = join(root, a, b, name)
        out.push({ sha256: name, path, size: (await stat(path)).size })
      }
    }
  }
  return out.sort((x, y) => x.sha256.localeCompare(y.sha256))
}

export const driveBlobPath = (driveDir: string, sha: string) => join(driveDir, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha)

async function uploadEncrypted(s3: S3Client, key: Buffer, objectKey: string, source: Readable): Promise<number> {
  const enc = encryptStream(key)
  source.on('error', (err) => enc.destroy(err))
  source.pipe(enc)
  return s3.upload(objectKey, enc)
}

export type RunStats = { snapshotId: string; bytesUploaded: number; blobsUploaded: number; blobsTotal: number; filesSize: number }

/** Take one snapshot. The manifest goes up last; any failure leaves no manifest. */
export async function takeSnapshot(s3: S3Client, key: Buffer, src: BackupSources, now: () => Date): Promise<RunStats> {
  const started = now()
  const id = snapshotId(started)
  const work = join(src.tmpDir, id)
  await rm(work, { recursive: true, force: true })
  await mkdir(work, { recursive: true, mode: 0o700 })
  try {
    // 1. Local consistent copies.
    await runToFile(src.dbDump, join(work, 'db.dump'))
    const absent: SnapshotFile[] = []
    if (await exists(src.agentDb)) await sqliteBackup(src.agentDb, join(work, 'agent.sqlite'))
    else absent.push('agent.sqlite')
    const present = []
    for (const p of src.eeState) if (await exists(p)) present.push(p.replace(/^\//, ''))
    if (present.length === 0) throw new Error(`none of ee's state paths exist (${src.eeState.join(', ')})`)
    await runToFile(['tar', '-C', '/', '-czf', '-', ...present], join(work, 'ee-state.tar.gz'))

    // 2. Snapshot files.
    let bytes = 0
    const files: Manifest['files'] = []
    for (const name of SNAPSHOT_FILES) {
      if (absent.includes(name)) continue
      const p = join(work, name)
      const h = await hashFile(p)
      bytes += await uploadEncrypted(s3, key, s3.key(`snapshots/${id}/${name}`), createReadStream(p))
      files.push({ name, ...h })
    }

    // 3. Drive blobs: content-addressed, so only new ones go up.
    const blobs = await listDriveBlobs(src.driveDir)
    const remote = new Set((await s3.list(s3.key('blobs/'))).map((o) => o.key))
    let blobsUploaded = 0
    for (const b of blobs) {
      const k = s3.key(`blobs/${b.sha256}`)
      if (remote.has(k)) continue
      bytes += await uploadEncrypted(s3, key, k, createReadStream(b.path))
      blobsUploaded++
    }

    // 4. The manifest, last.
    const manifest: Manifest = {
      format: 'ee-backup-manifest',
      version: 1,
      id,
      startedAt: started.toISOString(),
      finishedAt: now().toISOString(),
      files,
      absent,
      blobs: blobs.map((b) => ({ sha256: b.sha256, size: b.size })),
    }
    const m = Buffer.from(JSON.stringify(manifest))
    bytes += await uploadEncrypted(s3, key, s3.key(`snapshots/${id}/manifest.json`), streamOf(m))
    return { snapshotId: id, bytesUploaded: bytes, blobsUploaded, blobsTotal: blobs.length, filesSize: files.reduce((n, f) => n + f.size, 0) }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

function streamOf(b: Buffer): Readable {
  return Readable.from([b])
}

async function decryptToBuffer(s3: S3Client, key: Buffer, objectKey: string): Promise<Buffer> {
  const parts: Buffer[] = []
  await pipeline(
    await s3.getObject(objectKey),
    decryptStream(key),
    new Writable({
      write(c: Buffer, _e, cb) {
        parts.push(c)
        cb()
      },
    }),
  )
  return Buffer.concat(parts)
}

export type SnapshotListing = { id: string; complete: boolean; objects: string[] }

/** Snapshots in the bucket, oldest first. */
export async function listSnapshots(s3: S3Client): Promise<SnapshotListing[]> {
  const base = s3.key('snapshots/')
  const by = new Map<string, SnapshotListing>()
  for (const o of await s3.list(base)) {
    const [id, name] = o.key.slice(base.length).split('/')
    if (!id || !name) continue
    const s = by.get(id) ?? { id, complete: false, objects: [] }
    s.objects.push(o.key)
    if (name === 'manifest.json') s.complete = true
    by.set(id, s)
  }
  return [...by.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function readManifest(s3: S3Client, key: Buffer, id: string): Promise<Manifest> {
  let raw: Buffer
  try {
    raw = await decryptToBuffer(s3, key, s3.key(`snapshots/${id}/manifest.json`))
  } catch (err) {
    if (err instanceof S3Error && err.status === 404) throw new Error(`snapshot ${id} has no manifest — it is incomplete (the run that wrote it did not finish)`, { cause: err })
    throw err
  }
  const m = manifestSchema.parse(JSON.parse(raw.toString('utf8')))
  if (m.id !== id) throw new Error(`snapshot ${id}: its manifest names ${m.id} (objects were moved)`)
  return m
}

export async function resolveSnapshot(s3: S3Client, which: string): Promise<string> {
  const all = await listSnapshots(s3)
  if (which === 'latest') {
    const last = all.filter((s) => s.complete).at(-1)
    if (!last) throw new Error(`no complete snapshot under s3://${s3.target.bucket}/${s3.key('snapshots/')}`)
    return last.id
  }
  const hit = all.find((s) => s.id === which)
  if (!hit) throw new Error(`no snapshot ${which} (have: ${all.map((s) => s.id).join(', ') || 'none'})`)
  if (!hit.complete) throw new Error(`snapshot ${which} is incomplete (no manifest)`)
  return which
}

/** Download + decrypt one object into a file (or only hash it when dest is null); checks the expected sha256. */
async function fetchVerified(s3: S3Client, key: Buffer, objectKey: string, expect: string, dest: string | null): Promise<void> {
  const h = createHash('sha256')
  const out = dest ? createWriteStream(dest, { mode: 0o600 }) : null
  await pipeline(
    await s3.getObject(objectKey),
    decryptStream(key),
    new Writable({
      write(c: Buffer, _e, cb) {
        h.update(c)
        if (out) out.write(c, cb)
        else cb()
      },
      final(cb) {
        if (out) out.end(cb)
        else cb()
      },
    }),
  )
  const got = h.digest('hex')
  if (got !== expect) throw new Error(`${objectKey}: content hash ${got} does not match the manifest (${expect})`)
}

export type FetchedSnapshot = { manifest: Manifest; dir: string | null }

/**
 * Fetch a whole snapshot and check every byte against the manifest. With
 * dir === null nothing is written (verify); otherwise the files land in dir
 * and the Drive blobs in driveDir.
 */
export async function fetchSnapshot(
  s3: S3Client,
  key: Buffer,
  id: string,
  out: { dir: string; driveDir: string } | null,
  log: (line: string) => void = () => undefined,
): Promise<Manifest> {
  const m = await readManifest(s3, key, id)
  if (out) await mkdir(out.dir, { recursive: true, mode: 0o700 })
  for (const f of m.files) {
    log(`  ${f.name} (${f.size} bytes)`)
    await fetchVerified(s3, key, s3.key(`snapshots/${id}/${f.name}`), f.sha256, out ? join(out.dir, f.name) : null)
  }
  log(`  ${m.blobs.length} Drive blob(s)`)
  for (const b of m.blobs) {
    let dest: string | null = null
    if (out) {
      dest = driveBlobPath(out.driveDir, b.sha256)
      if ((await exists(dest)) && (await hashFile(dest)).sha256 === b.sha256) continue
      await mkdir(join(dest, '..'), { recursive: true })
    }
    await fetchVerified(s3, key, s3.key(`blobs/${b.sha256}`), b.sha256, dest)
  }
  return m
}

export type PruneResult = { snapshotsDeleted: string[]; blobsDeleted: number }

/**
 * Retention: complete snapshots older than `days` go (the newest complete one
 * always stays), abandoned incomplete ones older than a day go, then blobs no
 * remaining manifest references. A manifest that cannot be read stops the
 * blob sweep — ee never deletes a blob it cannot prove is unreferenced.
 */
export async function prune(s3: S3Client, key: Buffer, days: number, now: Date): Promise<PruneResult> {
  const all = await listSnapshots(s3)
  const complete = all.filter((s) => s.complete)
  const newest = complete.at(-1)?.id
  const cutoff = now.getTime() - days * 86_400_000
  const dayAgo = now.getTime() - 86_400_000
  const doomed = all.filter((s) => {
    const t = snapshotDate(s.id)?.getTime()
    if (t === undefined) return false
    if (s.complete) return s.id !== newest && t < cutoff
    return t < dayAgo
  })
  // Delete the manifest first: a half-deleted snapshot is then plainly incomplete.
  for (const s of doomed) {
    const ordered = [...s.objects].sort((a, b) => Number(b.endsWith('/manifest.json')) - Number(a.endsWith('/manifest.json')))
    for (const o of ordered) await s3.deleteObject(o)
  }
  const kept = complete.filter((s) => !doomed.includes(s))
  const referenced = new Set<string>()
  for (const s of kept) for (const b of (await readManifest(s3, key, s.id)).blobs) referenced.add(b.sha256)
  let blobsDeleted = 0
  const base = s3.key('blobs/')
  for (const o of await s3.list(base)) {
    const sha = o.key.slice(base.length)
    if (referenced.has(sha)) continue
    // A blob uploaded by a run still in progress has no manifest yet: runs are serialized, so none is.
    await s3.deleteObject(o.key)
    blobsDeleted++
  }
  return { snapshotsDeleted: doomed.map((s) => s.id), blobsDeleted }
}
