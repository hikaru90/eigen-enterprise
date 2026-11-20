import { Gzip } from 'fflate'

/**
 * A small ustar writer (POSIX.1-1988 + pax for long paths) for Drive folder
 * snapshots: regular files only, mode 0644, owner 0:0. A path that fits the
 * ustar name (100 bytes) or prefix/name split (155 + 100) goes in the header;
 * any longer one gets a pax `path` record first. Bytes stream through gzip
 * one file at a time, so a 200 MB snapshot never sits in memory whole.
 */

const BLOCK = 512
const enc = new TextEncoder()

export type TarFile = { path: string; size: number; mtime: Date }

/** 8 GiB - 1: the most an 11-digit octal size field holds. */
const MAX_OCTAL_SIZE = 0o77777777777

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0'
}

function put(header: Uint8Array, offset: number, length: number, value: string | Uint8Array): void {
  const bytes = typeof value === 'string' ? enc.encode(value) : value
  if (bytes.byteLength > length) throw new Error(`tar header field at ${offset} is ${bytes.byteLength} bytes, at most ${length}`)
  header.set(bytes, offset)
}

function checkPath(path: string): void {
  if (!path || path.startsWith('/') || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`tar path must be relative without empty, . or .. segments, got "${path}"`)
  }
}

/** The ustar name/prefix split for a path, or null when it fits neither (it then needs pax). */
function splitPath(path: string): { name: Uint8Array; prefix: Uint8Array } | null {
  const bytes = enc.encode(path)
  if (bytes.byteLength <= 100) return { name: bytes, prefix: new Uint8Array(0) }
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue
    const prefix = enc.encode(path.slice(0, i))
    const name = enc.encode(path.slice(i + 1))
    if (prefix.byteLength <= 155 && name.byteLength <= 100 && name.byteLength > 0) return { name, prefix }
  }
  return null
}

function header(fields: { name: Uint8Array; prefix: Uint8Array; size: number; mtime: Date; type: '0' | 'x' }): Uint8Array {
  if (!Number.isSafeInteger(fields.size) || fields.size < 0 || fields.size > MAX_OCTAL_SIZE) throw new Error(`tar entry size ${fields.size} is out of range`)
  const h = new Uint8Array(BLOCK)
  put(h, 0, 100, fields.name)
  put(h, 100, 8, octal(0o644, 8))
  put(h, 108, 8, octal(0, 8))
  put(h, 116, 8, octal(0, 8))
  put(h, 124, 12, octal(fields.size, 12))
  put(h, 136, 12, octal(Math.max(0, Math.floor(fields.mtime.getTime() / 1000)), 12))
  put(h, 148, 8, '        ')
  put(h, 156, 1, fields.type)
  put(h, 257, 6, 'ustar\0')
  put(h, 263, 2, '00')
  put(h, 345, 155, fields.prefix)
  let sum = 0
  for (const b of h) sum += b
  put(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return h
}

/** One pax record: "<len> <key>=<value>\n", where len counts the whole record. */
function paxRecord(key: string, value: string): Uint8Array {
  const body = enc.encode(` ${key}=${value}\n`)
  let len = body.byteLength + 1
  while (String(len).length + body.byteLength !== len) len = String(len).length + body.byteLength
  return enc.encode(`${len} ${key}=${value}\n`)
}

/** Zero bytes that fill an entry of `size` up to the next 512-byte block. */
export function tarPadding(size: number): Uint8Array {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)
}

/** Two zero blocks end the archive. */
export const TAR_END = new Uint8Array(2 * BLOCK)

/** The header block(s) for one regular file: a pax header + its data first when the path is too long for ustar. */
export function tarFileHeader(f: TarFile): Uint8Array {
  checkPath(f.path)
  const split = splitPath(f.path)
  if (split) return header({ ...split, size: f.size, mtime: f.mtime, type: '0' })
  const record = paxRecord('path', f.path)
  // The ustar fallback name for readers without pax: the path's last 100 ASCII-safe bytes.
  const fallback = enc.encode(f.path.replace(/[^\x20-\x7e]/g, '_').slice(-100))
  const pax = header({ name: enc.encode('PaxHeader'), prefix: new Uint8Array(0), size: record.byteLength, mtime: f.mtime, type: 'x' })
  const ustar = header({ name: fallback, prefix: new Uint8Array(0), size: f.size, mtime: f.mtime, type: '0' })
  const out = new Uint8Array(pax.byteLength + record.byteLength + tarPadding(record.byteLength).byteLength + ustar.byteLength)
  out.set(pax, 0)
  out.set(record, pax.byteLength)
  out.set(ustar, out.byteLength - ustar.byteLength)
  return out
}

export type TarSource = TarFile & { read: () => Promise<Uint8Array> }

/**
 * Writes `files` as a gzip'd tar through `write`, one file at a time. A file
 * whose bytes don't match its declared size fails loud (the header is
 * already out). Returns the bytes written.
 */
export async function writeTarGz(files: Iterable<TarSource> | AsyncIterable<TarSource>, write: (chunk: Uint8Array) => Promise<void>): Promise<number> {
  const pending: Uint8Array[] = []
  const gz = new Gzip({ level: 6 }, (chunk) => {
    pending.push(chunk)
  })
  let written = 0
  const flush = async () => {
    for (const chunk of pending.splice(0)) {
      await write(chunk)
      written += chunk.byteLength
    }
  }
  for await (const f of files) {
    const bytes = await f.read()
    if (bytes.byteLength !== f.size) throw new Error(`"${f.path}" is ${bytes.byteLength} bytes, its record says ${f.size}`)
    gz.push(tarFileHeader(f))
    gz.push(bytes)
    gz.push(tarPadding(f.size))
    await flush()
  }
  gz.push(TAR_END, true)
  await flush()
  return written
}
