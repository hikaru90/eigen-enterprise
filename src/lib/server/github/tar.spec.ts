import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReadStream } from 'node:fs'
import { gzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTarGz, TarError, type TarHeader } from './tar'

/** Every read stream the reader opens, so tests can see it was closed. */
const streams = vi.hoisted(() => [] as ReadStream[])
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    createReadStream: ((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = fs.createReadStream(...args)
      streams.push(stream)
      return stream
    }) as typeof fs.createReadStream,
  }
})

const BLOCK = 512
const encoder = new TextEncoder()
const dirs: string[] = []

afterEach(async () => {
  streams.splice(0)
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
  return file(gzipSync(tar))
}

async function file(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'github-tar-reader-'))
  dirs.push(dir)
  const path = join(dir, 'repo.tar.gz')
  await writeFile(path, bytes)
  return path
}

const END = new Uint8Array(2 * BLOCK)
const all = () => true

async function collect(path: string, want: (h: TarHeader) => boolean = all) {
  const entries = []
  for await (const entry of readTarGz(path, { want })) entries.push(entry)
  return entries
}

async function failure(p: Promise<unknown>): Promise<TarError> {
  const err = await p.then(
    () => {
      throw new Error('expected a TarError')
    },
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(TarError)
  return err as TarError
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

  it('asks want() per regular file with its header and skips unwanted bodies without yielding them', async () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(7)
    const path = await archive(
      concat([
        header({ path: 'docs', size: 0, type: '5' }),
        ...entry('skip/big.bin', big),
        ...entry('keep.txt', encoder.encode('kept'), 0o755),
        END,
      ]),
    )
    const seen: TarHeader[] = []
    const entries = await collect(path, (h) => {
      seen.push(h)
      return h.path === 'keep.txt'
    })
    expect(seen).toEqual([
      { path: 'skip/big.bin', size: big.byteLength, mode: 0o644 },
      { path: 'keep.txt', size: 4, mode: 0o755 },
    ])
    expect(entries).toEqual([{ path: 'keep.txt', mode: 0o755, bytes: encoder.encode('kept') }])
  })

  it('streams past an unwanted entry declaring 7 GiB without allocating it (fails on truncation, not memory)', async () => {
    const path = await archive(
      concat([header({ path: 'huge.bin', size: 7 * 1024 ** 3 }), new Uint8Array(4 * BLOCK)]),
    )
    const err = await failure(collect(path, () => false))
    expect(err.message).toMatch(/truncated/)
    expect(err.message).toContain('huge.bin')
  })

  it('closes the file when the consumer stops early', async () => {
    const path = await archive(
      concat([...entry('a.txt', encoder.encode('a')), ...entry('b.txt', encoder.encode('b')), END]),
    )
    for await (const entry of readTarGz(path, { want: all })) {
      expect(entry.path).toBe('a.txt')
      break
    }
    expect(streams).toHaveLength(1)
    expect(streams[0]!.destroyed).toBe(true)
  })

  it('closes the file when the archive turns out to be corrupt', async () => {
    const bad = header({ path: 'b.txt', size: 0 })
    bad[0] = 0x7a
    const path = await archive(concat([...entry('a.txt', encoder.encode('a')), bad, END]))
    await failure(collect(path))
    expect(streams).toHaveLength(1)
    expect(streams[0]!.destroyed).toBe(true)
  })

  it('applies a pax size only to the next file entry, never to a following pax header body', async () => {
    const longPath = `${'p'.repeat(150)}/file.txt`
    const path = await archive(
      concat([
        ...paxEntry(paxRecord('size', '5')),
        ...paxEntry(paxRecord('path', longPath)),
        // The ustar size field says 0; the first pax header's size (5) wins for this entry.
        header({ path: 'short', size: 0 }),
        encoder.encode('hello'),
        padding(5),
        ...entry('after.txt', encoder.encode('after')),
        END,
      ]),
    )
    const entries = await collect(path)
    expect(entries.map((e) => [e.path, new TextDecoder().decode(e.bytes)])).toEqual([
      [longPath, 'hello'],
      ['after.txt', 'after'],
    ])
  })

  it.each([
    ['/etc/passwd'],
    ['a/../../b'],
    ['..'],
    ['a//b'],
    ['./a'],
    ['a/./b'],
    ['a/'],
  ])('rejects the unsafe path %j loudly, naming it', async (bad) => {
    const path = await archive(concat([...entry(bad, encoder.encode('x')), END]))
    const err = await failure(collect(path))
    expect(err.message).toContain(JSON.stringify(bad))
  })

  it('rejects an unsafe pax path too', async () => {
    const path = await archive(
      concat([...paxEntry(paxRecord('path', 'repo/../../escape')), ...entry('fine.txt', encoder.encode('x')), END]),
    )
    const err = await failure(collect(path))
    expect(err.message).toContain('repo/../../escape')
  })

  it('accepts record padding of zeros after the end marker (git archive pads to 10240 bytes)', async () => {
    const tar = concat([...entry('a.txt', encoder.encode('a')), END])
    const padded = concat([tar, new Uint8Array(10240 - tar.byteLength)])
    expect((await collect(await archive(padded))).map((e) => e.path)).toEqual(['a.txt'])
  })

  it('requires two zero blocks at the end', async () => {
    const path = await archive(concat([...entry('a.txt', encoder.encode('a')), new Uint8Array(BLOCK)]))
    const err = await failure(collect(path))
    expect(err.message).toMatch(/end marker/)
  })

  it('rejects garbage after the end marker', async () => {
    const garbage = new Uint8Array(BLOCK)
    garbage[100] = 1
    const path = await archive(concat([...entry('a.txt', encoder.encode('a')), END, garbage]))
    const err = await failure(collect(path))
    expect(err.message).toMatch(/after the end marker/)
  })

  it('verifies the gzip trailer: a wrong CRC32 fails loud', async () => {
    const gz = gzipSync(concat([...entry('a.txt', encoder.encode('a')), END]))
    gz[gz.byteLength - 8] ^= 0xff
    const err = await failure(collect(await file(gz)))
    expect(err.message).toMatch(/CRC/)
  })

  it('verifies the gzip trailer: a wrong ISIZE fails loud', async () => {
    const gz = gzipSync(concat([...entry('a.txt', encoder.encode('a')), END]))
    gz[gz.byteLength - 1] ^= 0x01
    const err = await failure(collect(await file(gz)))
    expect(err.message).toMatch(/size/i)
  })

  it('rejects a GNU base-256 size (an entry of 8 GiB or more)', async () => {
    const h = header({ path: 'huge.bin', size: 0, sizeText: '' })
    // Base-256: high bit set in the first byte of the size field; recompute the checksum.
    h.fill(0, 124, 136)
    h[124] = 0x80
    h[135] = 0x02
    h.fill(0x20, 148, 156)
    let checksum = 0
    for (const byte of h) checksum += byte
    h.set(encoder.encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148)
    const err = await failure(collect(await archive(concat([h, END]))))
    expect(err.message).toMatch(/base-256/)
    expect(err.message).toContain('huge.bin')
  })

  it("reads type '7' (contiguous file) entries as regular files", async () => {
    const path = await archive(
      concat([header({ path: 'c.bin', size: 3, type: '7' }), encoder.encode('abc'), padding(3), END]),
    )
    expect(await collect(path)).toEqual([{ path: 'c.bin', mode: 0o644, bytes: encoder.encode('abc') }])
  })

  it('rejects multi-member gzip, whose trailers it cannot verify', async () => {
    const tar = concat([...entry('a.txt', encoder.encode('a')), END])
    const err = await failure(collect(await file(concat([gzipSync(tar.slice(0, BLOCK)), gzipSync(tar.slice(BLOCK))]))))
    expect(err.message).toMatch(/multi-member/)
  })

  it('rejects a gzip stream cut off before its trailer', async () => {
    const gz = gzipSync(concat([...entry('a.txt', encoder.encode('a')), END]))
    await failure(collect(await file(gz.slice(0, gz.byteLength - 4))))
  })
})
