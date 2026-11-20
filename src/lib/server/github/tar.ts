/**
 * Streaming reader for GitHub commit tarballs (plan/github-drive-full-mirror.md
 * §3). Gunzips on the fly with fflate's streaming `Gunzip` (single-member gzip,
 * which is what codeload sends), then iterates ustar entries — including the
 * prefix field and pax extended headers for long paths — one at a time.
 *
 * Memory stays bounded: the caller's `want(header)` decides per regular file
 * whether its bytes are needed; unwanted entries (and directories, links and
 * other non-file entries) are streamed past chunk by chunk, never buffered.
 * Only a wanted entry's bytes are ever held whole.
 *
 * Archive bytes are untrusted external data: every field is bounds-checked,
 * header checksums are verified, names must decode as strict UTF-8, paths
 * must be relative with no empty, `.` or `..` segment, the archive must end
 * in two zero blocks followed by nothing but zero padding, and the gzip
 * trailer (CRC32 + ISIZE, which fflate does not check) is verified against
 * the inflated stream. The trailer can only be checked at the very end, so a
 * consumer treats entries as provisional until the generator completes; the
 * caller's git blob sha check (§2.6) is the per-file integrity gate.
 */
import { createReadStream, type ReadStream } from 'node:fs'
import { crc32 } from 'node:zlib'
import { Gunzip } from 'fflate'

/** What `want` is shown for each regular file before its bytes are read. */
export type TarHeader = { path: string; size: number; mode: number }

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
 * leaves its output in `ready` and nothing is buffered beyond it. At the end
 * of the file it checks the gzip trailer against the inflated stream.
 */
class InflatedChunks {
  private readonly ready: Uint8Array[] = []
  private stream?: ReadStream
  private reader?: AsyncIterator<Uint8Array>
  private gun?: Gunzip
  private done = false
  /** CRC32 and length (mod 2^32) of everything inflated so far. */
  private crc = 0
  private inflated = 0
  /** The last 8 raw bytes read: the gzip trailer once the file ends. */
  private tail = new Uint8Array(0)
  private raw = 0

  constructor(private readonly path: string) {}

  /** The next gunzipped chunk, or null once the file is exhausted and verified. */
  async next(): Promise<Uint8Array | null> {
    if (this.ready.length > 0) return this.ready.shift() ?? null
    if (this.done) return null
    if (!this.gun) {
      this.gun = new Gunzip((chunk) => {
        this.crc = crc32(chunk, this.crc)
        this.inflated = (this.inflated + chunk.byteLength) % 2 ** 32
        this.ready.push(chunk)
      })
      this.gun.onmember = () => {
        throw new TarError(
          'the archive is a multi-member gzip; this reader only verifies single-member gzip (what GitHub sends)',
        )
      }
    }
    this.stream ??= createReadStream(this.path)
    this.reader ??= this.stream[Symbol.asyncIterator]()
    for (;;) {
      const { done, value } = await this.reader.next()
      if (done || value === undefined) {
        this.push(new Uint8Array(0), true)
        this.done = true
        this.verifyTrailer()
        return this.ready.shift() ?? null
      }
      const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      this.raw += chunk.byteLength
      this.tail =
        chunk.byteLength >= 8
          ? chunk.slice(chunk.byteLength - 8)
          : Uint8Array.from([...this.tail, ...chunk].slice(-8))
      this.push(chunk, false)
      if (this.ready.length > 0) return this.ready.shift() ?? null
    }
  }

  /** Stops reading and releases the file descriptor; safe to call twice. */
  close(): void {
    this.done = true
    this.stream?.destroy()
  }

  private push(chunk: Uint8Array, final: boolean): void {
    try {
      this.gun!.push(chunk, final)
    } catch (err) {
      if (err instanceof TarError) throw err
      throw new TarError(`the gzip stream is corrupt: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private verifyTrailer(): void {
    // 10-byte header + at least an empty deflate block + the 8-byte trailer.
    if (this.raw < 18 || this.tail.byteLength !== 8) {
      throw new TarError(`the gzip stream is too short (${this.raw} bytes) to carry its trailer`)
    }
    const view = new DataView(this.tail.buffer, this.tail.byteOffset, 8)
    const storedCrc = view.getUint32(0, true)
    const storedSize = view.getUint32(4, true)
    const crc = this.crc >>> 0
    if (storedCrc !== crc) {
      throw new TarError(
        `the gzip trailer CRC32 ${storedCrc.toString(16)} does not match the inflated data (${crc.toString(16)}); the archive is corrupt`,
      )
    }
    if (storedSize !== this.inflated) {
      throw new TarError(
        `the gzip trailer size ${storedSize} does not match the inflated data (${this.inflated} bytes mod 2^32); the archive is corrupt`,
      )
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
 * A path from the archive must stay inside it: relative, and no empty, `.`
 * or `..` segment. Anything else fails loud with the path named.
 */
function checkPath(path: string, at: number): void {
  const segments = path.split('/')
  if (path.startsWith('/') || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new TarError(
      `tar entry ${JSON.stringify(path)} (header at byte ${at}) has an unsafe path: it must be relative with no empty, "." or ".." segment`,
    )
  }
}

/** Type flags of entries that carry no file content for us; streamed past. */
const NON_FILE_TYPES = '123456'

/**
 * Iterates a `.tar.gz` on disk. `want` sees each regular file's header first;
 * only wanted files are read into memory and yielded, everything else is
 * streamed past. The generator's normal end means the archive ended cleanly
 * (two zero blocks, then only zero padding) and the gzip trailer matched.
 * The file is closed on every exit, including an early `break`/`return()`.
 */
export async function* readTarGz(
  path: string,
  opts: { want: (h: TarHeader) => boolean },
): AsyncGenerator<TarEntry, void, void> {
  const source = new InflatedChunks(path)
  try {
    yield* entries(source, opts.want)
  } finally {
    source.close()
  }
}

async function* entries(
  source: InflatedChunks,
  want: (h: TarHeader) => boolean,
): AsyncGenerator<TarEntry, void, void> {
  const queued: Uint8Array[] = []
  let queuedBytes = 0
  /** Bytes of the uncompressed tar consumed so far, for error context. */
  let consumed = 0
  /**
   * Overrides from the pax extended header(s) preceding the next entry. They
   * apply to the next non-pax entry only, never to another pax header's body.
   */
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
      const record = body.subarray(space + 1, at + length - 1)
      if (record.includes(0)) throw new TarError(`malformed pax record at byte ${at}: contains a NUL byte`)
      const keyValue = cString(record, 'pax record')
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

  /** After the first zero block: one more, then nothing but zero padding to EOF. */
  const finish = async (): Promise<void> => {
    if (!(await ensure(BLOCK)) || !isZeroBlock(take(BLOCK))) {
      throw new TarError(
        `tar end marker at byte ${consumed - BLOCK} is a single zero block; an archive ends with two`,
      )
    }
    consumed += BLOCK
    for (;;) {
      if (queuedBytes === 0) {
        const chunk = await source.next()
        if (chunk === null) return
        queued.push(chunk)
        queuedBytes += chunk.byteLength
      }
      const chunk = queued.shift()!
      queuedBytes -= chunk.byteLength
      const bad = chunk.findIndex((byte) => byte !== 0)
      if (bad !== -1) {
        throw new TarError(`unexpected data at byte ${consumed + bad} after the end marker; the archive is corrupt`)
      }
      consumed += chunk.byteLength
    }
  }

  for (;;) {
    if (!(await ensure(BLOCK))) {
      throw new TarError(
        `truncated tar: the stream ended at byte ${consumed} without the end marker`,
      )
    }
    const headerAt = consumed
    const header = take(BLOCK)
    consumed += BLOCK
    if (isZeroBlock(header)) {
      await finish()
      return
    }

    const storedChecksum = parseOctal(header.subarray(148, 156), 'header checksum')
    let checksum = 0
    for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 0x20 : header[i]!
    if (checksum !== storedChecksum) {
      throw new TarError(
        `tar header at byte ${headerAt} fails its checksum (stored ${storedChecksum}, computed ${checksum}); the archive is corrupt`,
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
        `tar header at byte ${headerAt} has magic ${JSON.stringify(String.fromCharCode(...magic))}; this reader only accepts ustar archives`,
      )
    }
    // Only POSIX ustar has a prefix field; GNU format reuses those bytes.
    const prefix = isPosixUstar ? cString(header.subarray(345, 500), 'prefix field') : ''

    if (sizeField[0]! & 0x80) {
      throw new TarError(
        `tar entry ${name} encodes its size in GNU base-256 (≥ 8 GiB); this reader rejects entries over 8 GiB`,
      )
    }
    const isPax = type === 'x' || type === 'g'
    const size = isPax ? parseOctal(sizeField, 'size field') : (paxSize ?? parseOctal(sizeField, 'size field'))
    if (size >= MAX_ENTRY_BYTES) {
      throw new TarError(
        `tar entry ${name} declares ${size} bytes; this reader rejects entries of 8 GiB or more`,
      )
    }

    if (isPax) {
      const body = await readBody(size, type === 'x' ? 'a pax extended header' : 'the pax global header')
      if (type === 'x') {
        // Several 'x' headers in a row merge; a later key wins.
        const overrides = parsePax(body)
        paxPath = overrides.path ?? paxPath
        paxSize = overrides.size ?? paxSize
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

    const entryPath = paxPath ?? (prefix === '' ? name : `${prefix}/${name}`)
    paxPath = null
    paxSize = null

    // Regular files: '0', NUL (pre-POSIX) and '7' (contiguous file, read as regular).
    const isRegular = header[156] === 0x30 || header[156] === 0x00 || type === '7'
    if (!isRegular) {
      // Known non-file entry types: links ('1','2'), devices ('3','4'),
      // directories ('5'), fifos ('6').
      if (!NON_FILE_TYPES.includes(type) || header[156] === 0x00) {
        throw new TarError(`tar entry ${entryPath} has unknown type ${JSON.stringify(type)}`)
      }
      // Directory names carry one trailing slash.
      checkPath(type === '5' && entryPath.endsWith('/') ? entryPath.slice(0, -1) : entryPath, headerAt)
      await skipBody(size, entryPath)
      continue
    }

    if (entryPath === '') {
      throw new TarError(`tar regular-file header at byte ${headerAt} has an empty name`)
    }
    checkPath(entryPath, headerAt)
    if (!want({ path: entryPath, size, mode })) {
      await skipBody(size, entryPath)
      continue
    }
    const bytes = await readBody(size, entryPath)
    yield { path: entryPath, mode, bytes }
  }
}
