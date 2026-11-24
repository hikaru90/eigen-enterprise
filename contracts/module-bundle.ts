import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateRawSync, gunzipSync } from 'node:zlib'

/**
 * A module bundle (plan/phase-upgrades-u2.md §6.1): the git tree of a module's
 * folder at a commit, as a deterministic `.tar.gz`. The same tree and commit
 * time always give the same bytes, so `bundleSha256` pins the code. Imported by
 * ee and the hub too, so only `node:*` — the tar writer is a minimal copy of
 * `modules/drive/tar.ts` (ustar + pax for long paths), extended with
 * directories and executable files.
 *
 * Paths inside the bundle are relative to the module folder: `module.yaml`
 * and `LICENSE` sit at the root.
 */

export const BUNDLE_LIMITS = {
  files: 5000,
  unpackedBytes: 20 * 1024 * 1024,
  packedBytes: 8 * 1024 * 1024,
} as const

export const BUNDLE_REQUIRED_FILES = ['module.yaml', 'LICENSE'] as const
/** The lockfiles `npm ci` builds from; one is required when package.json declares dependencies. */
export const BUNDLE_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'] as const

export type BundleFile = { path: string; content: Uint8Array; executable?: boolean }
export type BundleEntry =
  | { type: 'directory'; path: string; mode: 0o755 }
  | { type: 'file'; path: string; mode: 0o644 | 0o755; size: number; content: Uint8Array }
export type BundleProblem = { path?: string; message: string }

export class ModuleBundleError extends Error {
  readonly problems: BundleProblem[]
  constructor(problems: BundleProblem[]) {
    super(
      'module bundle is not valid: ' +
        problems.map((p) => (p.path ? `${p.path}: ${p.message}` : p.message)).join('; '),
    )
    this.name = 'ModuleBundleError'
    this.problems = problems
  }
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/** Why a path may never be in a bundle (nor committed to the module repo), or null. */
export function forbiddenBundlePath(path: string): string | null {
  const segments = path.split('/')
  if (segments.includes('node_modules')) return 'node_modules/ is never bundled'
  if (segments.includes('.git')) return '.git is never bundled'
  const base = segments[segments.length - 1]!
  if (base.startsWith('.env')) return '.env files hold secrets and are never bundled'
  if (base.endsWith('.pem') || base.endsWith('.key')) return 'key files are never bundled'
  if (base.startsWith('id_')) return 'SSH keys are never bundled'
  return null
}

function pathProblem(path: string): string | null {
  if (!path) return 'an empty path'
  if (path.startsWith('/')) return 'an absolute path'
  if (path.includes('\\') || path.includes('\0')) return 'a path with "\\" or NUL'
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..'))
    return 'a path with empty, "." or ".." segments'
  if (Buffer.byteLength(path) > 1024) return 'a path over 1024 bytes'
  return null
}

const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))

/** Every problem with a set of bundle files (paths, forbidden entries, required files, lockfile, limits). */
export function bundleFileProblems(
  files: readonly { path: string; size: number; content?: Uint8Array }[],
): BundleProblem[] {
  const problems: BundleProblem[] = []
  const seen = new Set<string>()
  let total = 0
  for (const f of files) {
    const bad = pathProblem(f.path)
    if (bad) problems.push({ path: f.path, message: bad })
    const forbidden = forbiddenBundlePath(f.path)
    if (forbidden) problems.push({ path: f.path, message: forbidden })
    if (seen.has(f.path)) problems.push({ path: f.path, message: 'listed twice' })
    seen.add(f.path)
    total += f.size
  }
  for (const required of BUNDLE_REQUIRED_FILES)
    if (!seen.has(required)) problems.push({ path: required, message: 'is required' })
  if (files.length > BUNDLE_LIMITS.files)
    problems.push({ message: `${files.length} files, at most ${BUNDLE_LIMITS.files}` })
  if (total > BUNDLE_LIMITS.unpackedBytes)
    problems.push({ message: `${total} bytes unpacked, at most ${BUNDLE_LIMITS.unpackedBytes}` })
  const pkg = files.find((f) => f.path === 'package.json')
  if (pkg?.content) {
    let deps = 0
    try {
      const json = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(pkg.content),
      ) as Record<string, unknown>
      for (const key of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]) {
        const v = json[key]
        if (v && typeof v === 'object') deps += Object.keys(v).length
      }
    } catch {
      problems.push({ path: 'package.json', message: 'is not valid JSON' })
    }
    if (deps > 0 && !BUNDLE_LOCKFILES.some((l) => seen.has(l)))
      problems.push({
        path: 'package-lock.json',
        message: 'is required when package.json declares dependencies',
      })
  }
  return problems
}

// ─── tar ─────────────────────────────────────────────────────────────────────

const BLOCK = 512
const enc = new TextEncoder()

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0'

function put(h: Uint8Array, offset: number, length: number, value: string | Uint8Array): void {
  const bytes = typeof value === 'string' ? enc.encode(value) : value
  if (bytes.byteLength > length)
    throw new Error(`tar header field at ${offset} is ${bytes.byteLength} bytes, at most ${length}`)
  h.set(bytes, offset)
}

function splitPath(path: string): { name: Uint8Array; prefix: Uint8Array } | null {
  const bytes = enc.encode(path)
  if (bytes.byteLength <= 100) return { name: bytes, prefix: new Uint8Array(0) }
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue
    const prefix = enc.encode(path.slice(0, i))
    const name = enc.encode(path.slice(i + 1))
    if (prefix.byteLength <= 155 && name.byteLength <= 100 && name.byteLength > 0)
      return { name, prefix }
  }
  return null
}

type HeaderFields = {
  name: Uint8Array
  prefix: Uint8Array
  size: number
  mtime: number
  mode: number
  type: '0' | '5' | 'x'
}

function header(f: HeaderFields): Uint8Array {
  const h = new Uint8Array(BLOCK)
  put(h, 0, 100, f.name)
  put(h, 100, 8, octal(f.mode, 8))
  put(h, 108, 8, octal(0, 8))
  put(h, 116, 8, octal(0, 8))
  put(h, 124, 12, octal(f.size, 12))
  put(h, 136, 12, octal(f.mtime, 12))
  put(h, 148, 8, '        ')
  put(h, 156, 1, f.type)
  put(h, 257, 6, 'ustar\0')
  put(h, 263, 2, '00')
  put(h, 345, 155, f.prefix)
  let sum = 0
  for (const b of h) sum += b
  put(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return h
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = enc.encode(` ${key}=${value}\n`)
  let len = body.byteLength + 1
  while (String(len).length + body.byteLength !== len) len = String(len).length + body.byteLength
  return enc.encode(`${len} ${key}=${value}\n`)
}

const padding = (size: number) => new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)

function entryHeader(
  path: string,
  f: { size: number; mtime: number; mode: number; type: '0' | '5' },
): Uint8Array[] {
  const split = splitPath(path)
  if (split) return [header({ ...split, ...f })]
  const record = paxRecord('path', path)
  const fallback = enc.encode(path.replace(/[^\x20-\x7e]/g, '_').slice(-99))
  return [
    header({
      name: enc.encode('PaxHeader'),
      prefix: new Uint8Array(0),
      size: record.byteLength,
      mtime: f.mtime,
      mode: 0o644,
      type: 'x',
    }),
    record,
    padding(record.byteLength),
    header({ name: fallback, prefix: new Uint8Array(0), ...f }),
  ]
}

/** gzip with a fixed header (mtime 0, no name, OS "unknown"), so the bytes never depend on the platform. */
function gzip(data: Uint8Array): Buffer {
  const head = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0xff])
  const body = deflateRawSync(data, { level: 9 })
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(data) >>> 0, 0)
  trailer.writeUInt32LE(data.byteLength % 2 ** 32, 4)
  return Buffer.concat([head, body, trailer])
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')

/**
 * Writes `files` as the module's bundle. Directories are derived from the
 * paths; entries are sorted bytewise; files are 0644 (0755 when executable),
 * directories 0755, uid/gid 0, every mtime the commit time, gzip mtime 0.
 * Any rule of §6.1 broken fails loud with every problem.
 */
export function createBundle(
  files: readonly BundleFile[],
  commitTime: Date,
): { bytes: Buffer; sha256: string } {
  const mtime = Math.floor(commitTime.getTime() / 1000)
  if (!Number.isSafeInteger(mtime) || mtime < 0)
    throw new Error('the commit time must be a valid date after 1970')
  const problems = bundleFileProblems(
    files.map((f) => ({ path: f.path, size: f.content.byteLength, content: f.content })),
  )
  if (problems.length) throw new ModuleBundleError(problems)
  const dirs = new Set<string>()
  for (const f of files) {
    const segs = f.path.split('/')
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'))
  }
  for (const f of files)
    if (dirs.has(f.path))
      throw new ModuleBundleError([{ path: f.path, message: 'is both a file and a directory' }])
  const entries = [
    ...[...dirs].map((path) => ({ path, file: null as BundleFile | null })),
    ...files.map((f) => ({ path: f.path, file: f as BundleFile | null })),
  ].sort((a, b) => compare(a.path, b.path))
  const chunks: Uint8Array[] = []
  for (const e of entries) {
    if (e.file === null) {
      chunks.push(...entryHeader(`${e.path}/`, { size: 0, mtime, mode: 0o755, type: '5' }))
    } else {
      const size = e.file.content.byteLength
      chunks.push(
        ...entryHeader(e.path, { size, mtime, mode: e.file.executable ? 0o755 : 0o644, type: '0' }),
      )
      chunks.push(e.file.content, padding(size))
    }
  }
  chunks.push(new Uint8Array(2 * BLOCK))
  const bytes = gzip(Buffer.concat(chunks))
  if (bytes.byteLength > BUNDLE_LIMITS.packedBytes)
    throw new ModuleBundleError([
      { message: `${bytes.byteLength} bytes packed, at most ${BUNDLE_LIMITS.packedBytes}` },
    ])
  return { bytes, sha256: sha256Hex(bytes) }
}

/**
 * The bundle of a directory tree (a checkout of the module folder at
 * `commitTime`). Symlinks and other non-regular entries fail loud; nothing is
 * skipped silently.
 */
export async function bundleFromDirectory(
  dir: string,
  commitTime: Date,
): Promise<{ bytes: Buffer; sha256: string }> {
  const files: BundleFile[] = []
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, rel))) {
      const path = rel ? `${rel}/${name}` : name
      const st = await lstat(join(dir, path))
      if (st.isDirectory()) await walk(path)
      else if (st.isFile())
        files.push({
          path,
          content: await readFile(join(dir, path)),
          executable: (st.mode & 0o111) !== 0,
        })
      else
        throw new ModuleBundleError([
          { path, message: 'is not a regular file or directory (links are never bundled)' },
        ])
    }
  }
  await walk('')
  return createBundle(files, commitTime)
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const field = (h: Uint8Array, offset: number, length: number): string => {
  const raw = h.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return Buffer.from(end === -1 ? raw : raw.subarray(0, end)).toString('utf8')
}
const octalField = (h: Uint8Array, offset: number, length: number): number => {
  const s = field(h, offset, length).trim()
  if (!/^[0-7]+$/.test(s)) return Number.NaN
  return parseInt(s, 8)
}

function parsePax(data: Uint8Array): { path?: string; problem?: string } {
  const buf = Buffer.from(data)
  let at = 0
  let path: string | undefined
  while (at < buf.byteLength) {
    const space = buf.indexOf(0x20, at)
    const len = space === -1 ? Number.NaN : Number(buf.subarray(at, space).toString('latin1'))
    if (
      !Number.isSafeInteger(len) ||
      len <= space - at + 1 ||
      at + len > buf.byteLength ||
      buf[at + len - 1] !== 0x0a
    )
      return { problem: 'a malformed pax record' }
    const kv = buf.subarray(space + 1, at + len - 1).toString('utf8')
    const eq = kv.indexOf('=')
    const key = eq === -1 ? kv : kv.slice(0, eq)
    if (key !== 'path') return { problem: `pax key "${key}" is not allowed (only path)` }
    path = kv.slice(eq + 1)
    at += len
  }
  return path === undefined ? { problem: 'a pax header without a path' } : { path }
}

/**
 * Reads and validates a bundle: the packed limit, gzip, every tar header
 * (checksum, regular files and directories only, modes, owner 0:0), paths,
 * sorted unique entries, the required and forbidden entries, the lockfile
 * rule and the unpacked limits. Every problem is collected, then thrown as one
 * `ModuleBundleError`; on success the entries come back in bundle order.
 */
export function readBundle(bytes: Uint8Array): { sha256: string; entries: BundleEntry[] } {
  if (bytes.byteLength > BUNDLE_LIMITS.packedBytes)
    throw new ModuleBundleError([
      { message: `${bytes.byteLength} bytes packed, at most ${BUNDLE_LIMITS.packedBytes}` },
    ])
  let tar: Buffer
  try {
    // Headers and padding on top of the unpacked limit: at most ~1.5 KiB per entry.
    tar = gunzipSync(bytes, {
      maxOutputLength: BUNDLE_LIMITS.unpackedBytes + (2 * BUNDLE_LIMITS.files + 2) * 3 * BLOCK,
    })
  } catch (err) {
    throw new ModuleBundleError([
      { message: `not a readable gzip within the limits (${(err as Error).message})` },
    ])
  }
  const problems: BundleProblem[] = []
  const entries: BundleEntry[] = []
  let at = 0
  let paxPath: string | undefined
  let ended = false
  while (at + BLOCK <= tar.byteLength) {
    const h = tar.subarray(at, at + BLOCK)
    if (h.every((b) => b === 0)) {
      ended = true
      break
    }
    const sum = h.reduce((s, b, i) => s + (i >= 148 && i < 156 ? 32 : b), 0)
    if (octalField(h, 148, 8) !== sum) {
      problems.push({ message: `a tar header at byte ${at} has a bad checksum` })
      break
    }
    const type = String.fromCharCode(h[156]!)
    const size = octalField(h, 124, 12)
    const mode = octalField(h, 100, 8)
    const prefix = field(h, 345, 155)
    let path = prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100)
    const dataStart = at + BLOCK
    at = dataStart + size + padding(size).byteLength
    if (!Number.isSafeInteger(size) || at > tar.byteLength) {
      problems.push({ message: `a tar entry at byte ${dataStart - BLOCK} runs past the end` })
      break
    }
    if (type === 'x') {
      const pax = parsePax(tar.subarray(dataStart, dataStart + size))
      if (pax.problem) problems.push({ message: pax.problem })
      paxPath = pax.path
      continue
    }
    if (paxPath !== undefined) path = paxPath
    paxPath = undefined
    if (octalField(h, 108, 8) !== 0 || octalField(h, 116, 8) !== 0)
      problems.push({ path, message: 'is not owned by 0:0' })
    if (type === '5') {
      if (!path.endsWith('/'))
        problems.push({ path, message: 'a directory entry must end with "/"' })
      path = path.replace(/\/$/, '')
      if (mode !== 0o755)
        problems.push({ path, message: `directory mode ${mode.toString(8)}, must be 755` })
      if (size !== 0) problems.push({ path, message: 'a directory with data' })
      entries.push({ type: 'directory', path, mode: 0o755 })
    } else if (type === '0') {
      if (mode !== 0o644 && mode !== 0o755)
        problems.push({ path, message: `file mode ${mode.toString(8)}, must be 644 or 755` })
      entries.push({
        type: 'file',
        path,
        mode: mode === 0o755 ? 0o755 : 0o644,
        size,
        content: new Uint8Array(tar.subarray(dataStart, dataStart + size)),
      })
    } else {
      problems.push({
        path,
        message: 'is not a regular file or directory (links and devices are never bundled)',
      })
    }
  }
  if (!ended) problems.push({ message: 'the tar archive has no end marker' })
  else if (!tar.subarray(at).every((b) => b === 0))
    problems.push({ message: 'data after the tar end marker' })
  for (let i = 1; i < entries.length; i++)
    if (compare(entries[i - 1]!.path, entries[i]!.path) >= 0)
      problems.push({ path: entries[i]!.path, message: 'entries are not sorted and unique' })
  const files = entries.filter(
    (e): e is Extract<BundleEntry, { type: 'file' }> => e.type === 'file',
  )
  const dirs = new Set(entries.filter((e) => e.type === 'directory').map((e) => e.path))
  for (const e of entries) {
    const parent = e.path.split('/').slice(0, -1).join('/')
    if (parent && !dirs.has(parent))
      problems.push({ path: e.path, message: 'its directory has no entry' })
    if (e.type === 'directory') {
      const bad = pathProblem(e.path) ?? forbiddenBundlePath(e.path)
      if (bad) problems.push({ path: e.path, message: bad })
    }
  }
  problems.push(...bundleFileProblems(files))
  if (problems.length) throw new ModuleBundleError(problems)
  return { sha256: sha256Hex(bytes), entries }
}

/** The text of one file in a read bundle, or null when it is not there. */
export function bundleFileText(entries: readonly BundleEntry[], path: string): string | null {
  const e = entries.find((x) => x.type === 'file' && x.path === path)
  return e && e.type === 'file' ? new TextDecoder('utf-8', { fatal: true }).decode(e.content) : null
}
