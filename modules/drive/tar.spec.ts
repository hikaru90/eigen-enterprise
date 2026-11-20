import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { gunzipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { TAR_END, tarFileHeader, tarPadding, writeTarGz, type TarSource } from './tar'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const text = (s: string) => new TextEncoder().encode(s)
const mtime = new Date('2026-11-20T10:00:00Z')
const src = (path: string, bytes: Uint8Array): TarSource => ({ path, size: bytes.byteLength, mtime, read: async () => bytes })

async function pack(files: TarSource[]): Promise<{ dir: string; gz: Uint8Array }> {
  const dir = await mkdtemp(join(tmpdir(), 'drive-tar-'))
  dirs.push(dir)
  const chunks: Uint8Array[] = []
  const n = await writeTarGz(files, async (c) => {
    chunks.push(c)
  })
  const gz = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    gz.set(c, at)
    at += c.byteLength
  }
  await writeFile(join(dir, 'snap.tar.gz'), gz)
  return { dir, gz }
}

async function listTree(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else out.push(relative(root, p))
    }
  }
  await walk(root)
  return out.sort()
}

describe('drive tar writer (ustar + pax, gzip)', () => {
  it('round-trips through the system tar: nested paths, an empty file, binary bytes', async () => {
    const binary = new Uint8Array(1500).map((_, i) => i % 256)
    const { dir } = await pack([
      src('package.json', text('{"scripts":{"dev":"vite"}}')),
      src('src/main.ts', text('console.log(1)\n')),
      src('src/empty.txt', new Uint8Array(0)),
      src('public/logo.bin', binary),
    ])
    const out = join(dir, 'out')
    await mkdir(out)
    execFileSync('tar', ['-xzf', join(dir, 'snap.tar.gz'), '-C', out])
    expect(await listTree(out)).toEqual(['package.json', 'public/logo.bin', 'src/empty.txt', 'src/main.ts'])
    expect(await readFile(join(out, 'src/main.ts'), 'utf8')).toBe('console.log(1)\n')
    expect(new Uint8Array(await readFile(join(out, 'public/logo.bin')))).toEqual(binary)
    expect((await readFile(join(out, 'src/empty.txt'))).byteLength).toBe(0)
  })

  it('long and non-ASCII paths survive: the ustar prefix split, and pax past it', async () => {
    const deep = `${'a'.repeat(120)}/${'b'.repeat(90)}.js`
    const longer = `${Array.from({ length: 6 }, (_, i) => `${i}`.repeat(60)).join('/')}/x.js`
    const { dir } = await pack([src(deep, text('deep')), src(longer, text('longer')), src('über/naïve ☕.md', text('é'))])
    const out = join(dir, 'out')
    await mkdir(out)
    execFileSync('tar', ['-xzf', join(dir, 'snap.tar.gz'), '-C', out])
    expect(await readFile(join(out, deep), 'utf8')).toBe('deep')
    expect(await readFile(join(out, longer), 'utf8')).toBe('longer')
    expect(await readFile(join(out, 'über/naïve ☕.md'), 'utf8')).toBe('é')
  })

  it('every entry is block aligned and the archive ends with two zero blocks', async () => {
    const { gz } = await pack([src('a.txt', text('hello'))])
    const tar = gunzipSync(gz)
    expect(tar.byteLength % 512).toBe(0)
    expect(tar.byteLength).toBe(512 + 512 + TAR_END.byteLength)
    expect(new TextDecoder().decode(tar.slice(257, 263))).toBe('ustar\0')
    expect(tarPadding(5).byteLength).toBe(507)
    expect(tarPadding(512).byteLength).toBe(0)
  })

  it('refuses absolute paths, dot segments and a file whose bytes differ from its size', async () => {
    for (const path of ['/etc/passwd', '../x', 'a/./b', 'a//b', '']) expect(() => tarFileHeader({ path, size: 0, mtime })).toThrow(/relative/)
    await expect(pack([{ path: 'a.txt', size: 3, mtime, read: async () => text('hello') }])).rejects.toThrow(/5 bytes, its record says 3/)
  })
})
