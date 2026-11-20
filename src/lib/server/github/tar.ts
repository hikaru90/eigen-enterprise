/**
 * Streaming reader for GitHub commit tarballs (plan/github-drive-full-mirror.md
 * §3). Gunzips on the fly with fflate's streaming `Gunzip` (single- and
 * multi-member gzip), then iterates ustar entries — including the prefix field
 * and pax extended headers for long paths — one at a time. Only ever one
 * entry's bytes are held in memory; the archive itself stays on disk.
 *
 * Archive bytes are untrusted external data: every field is bounds-checked,
 * header checksums are verified, names must decode as strict UTF-8, and
 * malformed or truncated structure fails loud. Directories, symlinks and other
 * non-file entries are part of every valid archive and are skipped by design —
 * the tree API reports them with their modes; nothing malformed is skipped.
 * fflate's streaming Gunzip does not verify the gzip checksum trailer, so gzip
 * corruption surfaces here as tar structure errors (checksum/truncation); the
 * caller's git blob sha check (§2.6) is the end-to-end integrity gate.
 */
import { createReadStream } from 'node:fs'
import { Gunzip } from 'fflate'

/** A regular file from the archive, with the archive's own path spelling. */
export type TarEntry = {
  path: string
  /** Permission bits as a number, e.g. `0o644`. */
  mode: number
  bytes: Uint8Array
}

export class TarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TarError'
  }
}

const BLOCK = 512
/** Past the ustar octal maximum (8 GiB − 1) and the plan's per-entry limit. */
const MAX_ENTRY_BYTES = 8 * 1024 ** 3
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/**
 * Pulls gunzipped chunks from the file on disk, reading a little at a time.
 * fflate's `ondata` fires synchronously during `push`, so a finished read
 * leaves its output in `ready` and nothing is buffered beyond it.
 */
class InflatedChunks {
  private readonly ready: Uint8Array[] = []
  private reader?: AsyncIterator<Uint8Array>
  private gun?: Gunzip
  private done = false

  constructor(private readonly path: string) {}

  /** The next gunzipped chunk, or null once the file is exhausted. */
  async next(): Promise<Uint8Array | null> {
    if (this.ready.length > 0) return this.ready.shift() ?? null
    if (this.done) return null
    this.gun ??= new Gunzip((chunk) => {
      this.ready.push(chunk)
    })
    this.reader ??= createReadStream(this.path)[Symbol.asyncIterator]()
    for (;;) {
      const { done, value } = await this.reader.next()
      if (done || value === undefined) {
        this.gun.push(new Uint8Array(0), true)
        this.done = true
        return this.ready.shift() ?? null
      }
      this.gun.push(value, false)
      if (this.ready.length > 0) return this.ready.shift() ?? null
    }
  }
}

const isZeroBlock = (block: Uint8Array): boolean => block.every((byte) => byte === 0)

/** Decodes a NUL-terminated tar string field, rejecting non-UTF-8 bytes. */
function cString(field: Uint8Array, what: string): string {
  const end = field.indexOf(0)
  const raw = end === -1 ? field : field.subarray(0, end)
  try {
    return UTF8.decode(raw)
  } catch {
    throw new TarError(`tar ${what} is not valid UTF-8`)
  }
}

/** An octal tar numeric field (leading zeros/spaces, NUL/space terminated). */
function parseOctal(field: Uint8Array, what: string): number {
  let start = 0
  while (start < field.length && field[start] === 0x20) start++
  let end = start
  let value = 0
  while (end < field.length && field[end]! >= 0x30 && field[end]! <= 0x37) {
    value = value * 8 + (field[end]! - 0x30)
    end++
  }
  for (let i = end; i < field.length; i++) {
    if (field[i] !== 0 && field[i] !== 0x20) {
      throw new TarError(`tar ${what} is not an octal number`)
    }
  }
  return value
}

/**
 * Iterates a `.tar.gz` on disk. Yields regular files only; the generator's
 * end means the archive ended cleanly at its zero-block end marker.
 */
export async function* readTarGz(path: string): AsyncGenerator<TarEntry, void, void> {
  const source = new InflatedChunks(path)
  const queued: Uint8Array[] = []
  let queuedBytes = 0
  /** Bytes of the uncompressed tar consumed so far, for error context. */
  let consumed = 0
  /** Overrides from the pax extended header preceding the next entry. */
  let paxPath: string | null = null
  let paxSize: number | null = null

  /** Waits until at least `n` bytes are buffered; false on end of stream. */
  const ensure = async (n: number): Promise<boolean> => {
    while (queuedBytes < n) {
      const chunk = await source.next()
      if (chunk === null) return false
      queued.push(chunk)
      queuedBytes += chunk.byteLength
    }
    return true
  }
  /** Takes exactly `n` buffered bytes (`ensure(n)` held true) as one array. */
  const take = (n: number): Uint8Array => {
    if (n === 0) return new Uint8Array(0)
    const out = new Uint8Array(n)
    let filled = 0
    while (filled < n) {
      const chunk = queued[0]!
      const use = Math.min(chunk.byteLength, n - filled)
      out.set(use === chunk.byteLength ? chunk : chunk.subarray(0, use), filled)
      filled += use
      queuedBytes -= use
      if (use === chunk.byteLength) queued.shift()
      else queued[0] = chunk.subarray(use)
    }
    return out
  }
  /** Drops `n` bytes without materialising them; false on end of stream. */
  const drop = async (n: number): Promise<boolean> => {
    let left = n
    while (left > 0) {
      if (queuedBytes === 0) {
        const chunk = await source.next()
        if (chunk === null) return false
        queued.push(chunk)
        queuedBytes += chunk.byteLength
      }
      const chunk = queued[0]!
      const use = Math.min(chunk.byteLength, left)
      queuedBytes -= use
      left -= use
      if (use === chunk.byteLength) queued.shift()
      else queued[0] = chunk.subarray(use)
    }
    return true
  }
  const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK

  /** An entry body plus its block padding; truncation fails loud. */
  const readBody = async (size: number, what: string): Promise<Uint8Array> => {
    if (!(await ensure(size)))
      throw new TarError(`truncated tar: the stream ended inside the body of ${what} (byte ${consumed})`)
    const body = take(size)
    consumed += size
    if (!(await drop(padding(size))))
      throw new TarError(`truncated tar: the stream ended in the padding of ${what} (byte ${consumed})`)
    consumed += padding(size)
    return body
  }
  /** Consumes a body that carries no file bytes (directories, symlinks…). */
  const skipBody = async (size: number, what: string): Promise<void> => {
    if (!(await drop(size)))
      throw new TarError(`truncated tar: the stream ended inside the body of ${what} (byte ${consumed})`)
    consumed += size
    if (!(await drop(padding(size))))
      throw new TarError(`truncated tar: the stream ended in the padding of ${what} (byte ${consumed})`)
    consumed += padding(size)
  }

  /**
   * Parses pax extended-header records (`"<length> <key>=<value>\n"`), where
   * `<length>` counts the whole record. Every boundary is bounds-checked; only
   * `path` and `size` change how this reader reads, everything else is
   * metadata we do not use.
   */
  const parsePax = (body: Uint8Array): { path: string | null; size: number | null } => {
    let path: string | null = null
    let size: number | null = null
    let at = 0
    while (at < body.byteLength) {
      let space = at
      while (space < body.byteLength && body[space]! >= 0x30 && body[space]! <= 0x39) space++
      if (
        space === at ||
        space >= body.byteLength ||
        body[space] !== 0x20
      ) {
        throw new TarError(`malformed pax record at byte ${at}: expected "<length> <key>=<value>"`)
      }
      let length = 0
      for (let i = at; i < space; i++) length = length * 10 + (body[i]! - 0x30)
      if (length <= space - at + 1 || at + length > body.byteLength) {
        throw new TarError(
          `malformed pax record at byte ${at}: length ${length} does not fit within the extended header`,
        )
      }
      if (body[at + length - 1] !== 0x0a) {
        throw new TarError(`malformed pax record at byte ${at}: record does not end with a newline`)
      }
      const keyValue = cString(body.subarray(space + 1, at + length - 1), 'pax record')
      const eq = keyValue.indexOf('=')
      if (eq <= 0) throw new TarError(`malformed pax record at byte ${at}: no key=value`)
      const key = keyValue.slice(0, eq)
      const value = keyValue.slice(eq + 1)
      if (key === 'path') path = value
      else if (key === 'size') {
        if (!/^\d+$/.test(value) || Number(value) > Number.MAX_SAFE_INTEGER) {
          throw new TarError(`malformed pax size record at byte ${at}: ${JSON.stringify(value)}`)
        }
        size = Number(value)
      }
      at += length
    }
    return { path, size }
  }

  for (;;) {
    if (!(await ensure(BLOCK))) {
      throw new TarError(
        `truncated tar: the stream ended at byte ${consumed} without the end marker`,
      )
    }
    const header = take(BLOCK)
    consumed += BLOCK
    if (isZeroBlock(header)) return

    const storedChecksum = parseOctal(header.subarray(148, 156), 'header checksum')
    let checksum = 0
    for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 0x20 : header[i]!
    if (checksum !== storedChecksum) {
      throw new TarError(
        `tar header at byte ${consumed - BLOCK} fails its checksum (stored ${storedChecksum}, computed ${checksum}); the archive is corrupt`,
      )
    }

    const name = cString(header.subarray(0, 100), 'name field')
    const mode = parseOctal(header.subarray(100, 108), 'mode field')
    const sizeField = header.subarray(124, 136)
    const type = String.fromCharCode(header[156]!)
    const magic = header.subarray(257, 263)
    const isPosixUstar =
      magic[0] === 0x75 && magic[1] === 0x73 && magic[2] === 0x74 && magic[3] === 0x61 && magic[4] === 0x72 && magic[5] === 0x00
    const isGnuUstar =
      magic[0] === 0x75 && magic[1] === 0x73 && magic[2] === 0x74 && magic[3] === 0x61 && magic[4] === 0x72 && magic[5] === 0x20
    if (!isPosixUstar && !isGnuUstar) {
      throw new TarError(
        `tar header at byte ${consumed - BLOCK} has magic ${JSON.stringify(String.fromCharCode(...magic))}; this reader only accepts ustar archives`,
      )
    }
    // Only POSIX ustar has a prefix field; GNU format reuses those bytes.
    const prefix = isPosixUstar ? cString(header.subarray(345, 500), 'prefix field') : ''

    if (sizeField[0]! & 0x80) {
      throw new TarError(
        `tar entry ${name} encodes its size in GNU base-256 (≥ 8 GiB); this reader rejects entries over 8 GiB`,
      )
    }
    const size = paxSize ?? parseOctal(sizeField, 'size field')
    if (size >= MAX_ENTRY_BYTES) {
      throw new TarError(
        `tar entry ${name} declares ${size} bytes; this reader rejects entries of 8 GiB or more`,
      )
    }

    if (type === 'x' || type === 'g') {
      const body = await readBody(size, type === 'x' ? 'a pax extended header' : 'the pax global header')
      if (type === 'x') {
        const overrides = parsePax(body)
        paxPath = overrides.path
        paxSize = overrides.size
      }
      // 'g' (git's pax_global_header) carries archive-wide metadata, not
      // per-entry overrides; it is read and dropped.
      continue
    }
    if (type === 'L' || type === 'K') {
      throw new TarError(
        `GNU ${type === 'L' ? 'long-name' : 'long-link'} entries are not supported (only ustar and pax)`,
      )
    }

    const isRegular = header[156] === 0x30 || header[156] === 0x00
    if (!isRegular) {
      // Known non-file entry types: links ('1','2'), directories ('5'),
      // devices ('3','4'), fifos ('6'), contiguous files ('7').
      if (!'1234567'.includes(type)) {
        throw new TarError(`tar entry ${name} has unknown type ${JSON.stringify(type)}`)
      }
      await skipBody(size, name)
      paxPath = null
      paxSize = null
      continue
    }

    const path = paxPath ?? (prefix === '' ? name : `${prefix}/${name}`)
    paxPath = null
    paxSize = null
    if (path === '') {
      throw new TarError(`tar regular-file header at byte ${consumed - BLOCK} has an empty name`)
    }
    const bytes = await readBody(size, path)
    yield { path, mode, bytes }
  }
}
