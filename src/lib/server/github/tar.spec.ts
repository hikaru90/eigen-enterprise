import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { readTarGz } from './tar'

const BLOCK = 512
const encoder = new TextEncoder()
const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0'
}

function field(header: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = encoder.encode(value)
  if (bytes.byteLength > width) throw new Error(`test tar field is too wide: ${value}`)
  header.set(bytes, offset)
}

function header(input: {
  path: string
  size: number
  mode?: number
  type?: string
  prefix?: string
  sizeText?: string
}): Uint8Array {
  const out = new Uint8Array(BLOCK)
  field(out, 0, 100, input.path)
  field(out, 100, 8, octal(input.mode ?? 0o644, 8))
  field(out, 108, 8, octal(0, 8))
  field(out, 116, 8, octal(0, 8))
  field(out, 124, 12, input.sizeText ?? octal(input.size, 12))
  field(out, 136, 12, octal(0, 12))
  field(out, 148, 8, '        ')
  field(out, 156, 1, input.type ?? '0')
  field(out, 257, 6, 'ustar\0')
  field(out, 263, 2, '00')
  field(out, 345, 155, input.prefix ?? '')
  let checksum = 0
  for (const byte of out) checksum += byte
  field(out, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')
  return out
}

function padding(size: number): Uint8Array {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK)
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function entry(path: string, bytes: Uint8Array, mode = 0o644): Uint8Array[] {
  return [header({ path, size: bytes.byteLength, mode }), bytes, padding(bytes.byteLength)]
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = encoder.encode(` ${key}=${value}\n`)
  let length = body.byteLength + 1
  while (String(length).length + body.byteLength !== length) length = String(length).length + body.byteLength
  return encoder.encode(`${length} ${key}=${value}\n`)
}

function paxEntry(record: Uint8Array): Uint8Array[] {
  return [header({ path: 'PaxHeader', size: record.byteLength, type: 'x' }), record, padding(record.byteLength)]
}

async function archive(tar: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'github-tar-reader-'))
  dirs.push(dir)
  const path = join(dir, 'repo.tar.gz')
  // Tiny compressed writes make the reader cross chunk boundaries inside headers and bodies.
  await writeFile(path, gzipSync(tar))
  return path
}

async function collect(path: string) {
  const entries = []
  for await (const entry of readTarGz(path)) entries.push(entry)
  return entries
}

describe('readTarGz', () => {
  it('streams ustar regular files with binary fidelity and modes, and skips other entry types', async () => {
    const binary = Uint8Array.from({ length: 1500 }, (_, i) => i % 256)
    const path = await archive(
      concat([
        header({ path: 'docs', size: 0, type: '5' }),
        ...entry('README.md', encoder.encode('# hello\n')),
        ...entry('bin/run', binary, 0o755),
        header({ path: 'latest', size: 0, type: '2' }),
        new Uint8Array(2 * BLOCK),
      ]),
    )

    const entries = await collect(path)
    expect(entries.map(({ path, mode }) => ({ path, mode }))).toEqual([
      { path: 'README.md', mode: 0o644 },
      { path: 'bin/run', mode: 0o755 },
    ])
    expect(entries[0]!.bytes).toEqual(encoder.encode('# hello\n'))
    expect(entries[1]!.bytes).toEqual(binary)
    expect(Buffer.isBuffer(entries[1]!.bytes)).toBe(false)
  })

  it('reads ustar prefix/name paths and pax long paths', async () => {
    const prefix = 'a'.repeat(120)
    const longPath = `${Array.from({ length: 6 }, (_, i) => `${i}`.repeat(60)).join('/')}/x.js`
    const record = paxRecord('path', longPath)
    const tar = concat([
      header({ path: 'b'.repeat(90), prefix, size: 5 }),
      encoder.encode('ustar'),
      padding(5),
      ...paxEntry(record),
      header({ path: 'short-fallback', size: 4 }),
      encoder.encode('pax!'),
      padding(4),
      new Uint8Array(2 * BLOCK),
    ])
    const prefixedPath = await archive(tar)

    expect((await collect(prefixedPath)).map((entry) => [entry.path, new TextDecoder().decode(entry.bytes)])).toEqual([
      [`${prefix}/${'b'.repeat(90)}`, 'ustar'],
      [longPath, 'pax!'],
    ])
  })

  it('rejects a pax-declared file over 8 GiB before trying to allocate or read its body', async () => {
    const oversized = 8 * 1024 ** 3 + 1
    const path = await archive(
      concat([
        ...paxEntry(paxRecord('size', String(oversized))),
        header({ path: 'huge.bin', size: 0 }),
        new Uint8Array(2 * BLOCK),
      ]),
    )

    await expect(collect(path)).rejects.toThrow(/8 GiB/)
  })

  it('rejects truncation inside a file and a missing tar end marker', async () => {
    const complete = concat([...entry('a.txt', encoder.encode('hello')), new Uint8Array(2 * BLOCK)])
    const truncatedBody = await archive(complete.slice(0, BLOCK + 2))
    await expect(collect(truncatedBody)).rejects.toThrow(/truncated/i)

    const noEnd = await archive(concat(entry('a.txt', encoder.encode('hello'))))
    await expect(collect(noEnd)).rejects.toThrow(/truncated|end marker/i)
  })

  it('rejects a malformed header checksum and malformed gzip', async () => {
    const badHeader = header({ path: 'a.txt', size: 0 })
    badHeader[0] = encoder.encode('z')[0]!
    const path = await archive(concat([badHeader, new Uint8Array(2 * BLOCK)]))
    await expect(collect(path)).rejects.toThrow(/checksum/i)

    const dir = await mkdtemp(join(tmpdir(), 'github-tar-reader-'))
    dirs.push(dir)
    const badGzip = join(dir, 'bad.tar.gz')
    await writeFile(badGzip, Uint8Array.from([0x1f, 0x8b, 0x08, 0, 1, 2, 3]))
    await expect(collect(badGzip)).rejects.toThrow()
  })
})
