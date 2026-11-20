import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

/**
 * The Drive snapshot a preview runs (plan/phase-drive-app-preview.md, contract):
 * a gzip tarball of regular files and directories, every path inside the folder.
 * ee reads every header BEFORE anything is unpacked and refuses the whole
 * tarball on the first entry that is anything else — never "skip the bad one".
 */

export class UnsafeTarballError extends Error {}

/** The contract's caps on a snapshot (the kernel enforces them too). */
export const SNAPSHOT_LIMITS = { files: 20_000, bytes: 200 * 1024 * 1024 }

export type TarSummary = { files: number; bytes: number }

/** pax / GNU long-name payloads are tiny; anything bigger is not a snapshot. */
const MAX_META = 1024 * 1024

const REFUSED_TYPES: Record<string, string> = {
  '1': 'hard link',
  '2': 'symbolic link',
  '3': 'character device',
  '4': 'block device',
  '6': 'FIFO',
  K: 'GNU long link name',
  g: 'global pax header',
}

function cString(b: Buffer, start: number, len: number): string {
  const slice = b.subarray(start, start + len)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

function octal(b: Buffer, start: number, len: number, what: string): number {
  if (((b[start] ?? 0) & 0x80) !== 0) throw new UnsafeTarballError(`${what}: base-256 sizes are not accepted in a snapshot`)
  const text = cString(b, start, len).trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) throw new UnsafeTarballError(`${what}: malformed number "${text}" in a tar header`)
  return parseInt(text, 8)
}

function checksumOk(b: Buffer): boolean {
  let sum = 0
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (b[i] ?? 0)
  return octal(b, 148, 8, 'checksum') === sum
}

/** pax extended header records: "<len> <key>=<value>\n". */
function paxRecords(payload: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let at = 0
  while (at < payload.length) {
    if (payload[at] === 0) break
    const space = payload.indexOf(0x20, at)
    if (space === -1) throw new UnsafeTarballError('malformed pax header')
    const len = Number(payload.subarray(at, space).toString('ascii'))
    if (!Number.isInteger(len) || len <= 0 || at + len > payload.length) throw new UnsafeTarballError('malformed pax header')
    const record = payload.subarray(space + 1, at + len - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq === -1) throw new UnsafeTarballError('malformed pax header')
    out[record.slice(0, eq)] = record.slice(eq + 1)
    at += len
  }
  return out
}

/** The entry's path, checked: relative, no "..", never empty for a file. */
function safePath(raw: string, isDir: boolean): string {
  if (raw.startsWith('/')) throw new UnsafeTarballError(`"${raw}": absolute paths are not allowed in a snapshot`)
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.includes('..')) throw new UnsafeTarballError(`"${raw}": ".." is not allowed in a snapshot path`)
  if (parts.length === 0 && !isDir) throw new UnsafeTarballError(`a file entry has an empty path`)
  return parts.join('/')
}

type Pending = { kind: 'x' | 'L'; remaining: number; padding: number; chunks: Buffer[] }

/**
 * Streaming header scan: data blocks are skipped, never held. push() throws on
 * the first unsafe entry; finish() throws when the archive is cut short.
 */
export class TarScanner {
  private buf: Buffer = Buffer.alloc(0)
  /** Bytes of entry data (plus padding) still to skip. */
  private skip = 0
  private meta: Pending | null = null
  private nextPath: string | null = null
  private nextSize: number | null = null
  private zeroBlocks = 0
  private done = false
  private files = 0
  private bytes = 0

  constructor(private readonly limits: { files: number; bytes: number } = SNAPSHOT_LIMITS) {}

  push(chunk: Buffer): void {
    if (this.done) return
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    for (;;) {
      if (this.done) {
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.meta) {
        const m = this.meta
        if (m.remaining > 0) {
          const take = Math.min(m.remaining, this.buf.length)
          if (take === 0) return
          m.chunks.push(this.buf.subarray(0, take))
          m.remaining -= take
          this.buf = this.buf.subarray(take)
          if (m.remaining > 0) return
        }
        const payload = Buffer.concat(m.chunks)
        this.meta = null
        this.skip = m.padding
        if (m.kind === 'L') {
          this.nextPath = cString(payload, 0, payload.length)
        } else {
          const rec = paxRecords(payload)
          if (rec['path'] !== undefined) this.nextPath = rec['path']
          if (rec['size'] !== undefined) {
            const size = Number(rec['size'])
            if (!Number.isSafeInteger(size) || size < 0) throw new UnsafeTarballError('malformed pax size')
            this.nextSize = size
          }
        }
        continue
      }
      if (this.skip > 0) {
        const take = Math.min(this.skip, this.buf.length)
        if (take === 0) return
        this.skip -= take
        this.buf = this.buf.subarray(take)
        continue
      }
      if (this.buf.length < 512) return
      const h = this.buf.subarray(0, 512)
      this.buf = this.buf.subarray(512)
      this.header(h)
    }
  }

  private header(h: Buffer): void {
    if (h.every((b) => b === 0)) {
      if (++this.zeroBlocks === 2) this.done = true
      return
    }
    if (this.zeroBlocks > 0) throw new UnsafeTarballError('a tar header follows an end-of-archive block')
    if (!checksumOk(h)) throw new UnsafeTarballError('a tar header has a bad checksum (not a tar archive, or corrupt)')
    const type = String.fromCharCode(h[156] ?? 0)
    const ustar = cString(h, 257, 6).startsWith('ustar')
    const prefix = ustar ? cString(h, 345, 155) : ''
    const name = cString(h, 0, 100)
    const headerPath = prefix ? `${prefix}/${name}` : name
    let size = octal(h, 124, 12, headerPath)
    const padded = (n: number) => Math.ceil(n / 512) * 512

    if (type === 'x' || type === 'L') {
      if (size > MAX_META) throw new UnsafeTarballError(`"${headerPath}": oversized ${type === 'x' ? 'pax' : 'long name'} header`)
      this.meta = { kind: type, remaining: size, padding: padded(size) - size, chunks: [] }
      return
    }
    const refused = REFUSED_TYPES[type]
    const path = this.nextPath ?? headerPath
    if (this.nextSize !== null) size = this.nextSize
    this.nextPath = null
    this.nextSize = null
    if (refused) throw new UnsafeTarballError(`"${path}" is a ${refused}; a snapshot holds only regular files and directories`)
    if (type === '5') {
      safePath(path, true)
      this.skip = padded(size)
      return
    }
    if (type !== '0' && type !== '\0' && type !== '7') {
      throw new UnsafeTarballError(`"${path}" has tar entry type "${type}"; a snapshot holds only regular files and directories`)
    }
    safePath(path, false)
    this.files += 1
    this.bytes += size
    if (this.files > this.limits.files) throw new UnsafeTarballError(`the snapshot has more than ${this.limits.files} files`)
    if (this.bytes > this.limits.bytes) throw new UnsafeTarballError(`the snapshot unpacks to more than ${this.limits.bytes} bytes`)
    this.skip = padded(size)
  }

  finish(): TarSummary {
    if (this.meta || this.skip > 0 || this.buf.length > 0 || (!this.done && this.zeroBlocks === 0)) {
      throw new UnsafeTarballError('the tarball is truncated')
    }
    return { files: this.files, bytes: this.bytes }
  }
}

/** Scan a gzip tarball on disk (ee's own root-only copy, so it cannot change underneath). */
export async function scanTarball(path: string): Promise<TarSummary> {
  const scanner = new TarScanner()
  const gunzip = createGunzip()
  try {
    for await (const chunk of createReadStream(path).pipe(gunzip)) scanner.push(chunk as Buffer)
  } catch (err) {
    if (err instanceof UnsafeTarballError) throw err
    throw new UnsafeTarballError(`not a gzip tarball: ${(err as Error).message}`, { cause: err })
  } finally {
    gunzip.destroy()
  }
  return scanner.finish()
}
