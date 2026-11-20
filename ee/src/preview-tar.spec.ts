import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { scanTarball, SNAPSHOT_LIMITS, TarScanner, UnsafeTarballError } from './preview-tar.ts'

/** One ustar header block (checksum filled in). */
function header(name: string, type: string, size = 0, extra: { prefix?: string; linkname?: string; badChecksum?: boolean } = {}): Buffer {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100, 'utf8')
  b.write('0000644\0', 100)
  b.write('0000000\0', 108)
  b.write('0000000\0', 116)
  b.write(size.toString(8).padStart(11, '0') + '\0', 124)
  b.write('00000000000\0', 136)
  b.write(type, 156)
  if (extra.linkname) b.write(extra.linkname, 157, 100)
  b.write('ustar\0', 257)
  b.write('00', 263)
  if (extra.prefix) b.write(extra.prefix, 345, 155)
  b.fill(' ', 148, 156)
  let sum = 0
  for (const byte of b) sum += byte
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  if (extra.badChecksum) b[0] = (b[0] ?? 0) ^ 1
  return b
}

function data(content: Buffer | string): Buffer {
  const d = Buffer.from(content)
  const padded = Buffer.alloc(Math.ceil(d.length / 512) * 512)
  d.copy(padded)
  return padded
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`
  let len = body.length + 1
  while (String(len).length + body.length !== len) len = String(len).length + body.length
  return `${len}${body}`
}

const file = (name: string, content: string, extra: Parameters<typeof header>[3] = {}) => [header(name, '0', Buffer.byteLength(content), extra), data(content)]
const end = () => Buffer.alloc(1024)

function scan(blocks: Buffer[], chunk = 0): ReturnType<TarScanner['finish']> {
  const s = new TarScanner()
  const all = Buffer.concat(blocks)
  if (chunk === 0) s.push(all)
  else for (let i = 0; i < all.length; i += chunk) s.push(all.subarray(i, i + chunk))
  return s.finish()
}

describe('snapshot tarball scan (only regular files and directories, inside the folder)', () => {
  it('accepts regular files and directories and counts them', () => {
    const r = scan([header('src/', '5'), ...file('src/main.ts', 'console.log(1)\n'), ...file('package.json', '{}'), end()])
    expect(r).toEqual({ files: 2, bytes: 15 + 2 })
  })

  it('handles headers and data split across arbitrary chunks', () => {
    const blocks = [...file('a.txt', 'x'.repeat(1300)), ...file('b.txt', 'y'), end()]
    for (const chunk of [1, 7, 511, 513, 4096]) expect(scan(blocks, chunk)).toEqual({ files: 2, bytes: 1301 })
  })

  it('long names: ustar prefix, pax path and GNU long names', () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(90)}.js`
    const pax = paxRecord('path', long)
    const r = scan([
      ...file('f.js', 'a', { prefix: 'some/deep/dir' }),
      header('PaxHeader/x', 'x', Buffer.byteLength(pax)),
      data(pax),
      ...file('ignored-short-name', 'bb'),
      header('././@LongLink', 'L', long.length + 1),
      data(long + '\0'),
      ...file('ignored-too', 'ccc'),
      end(),
    ])
    expect(r).toEqual({ files: 3, bytes: 6 })
  })

  it('a pax size overrides the header size', () => {
    const pax = paxRecord('size', '3')
    expect(scan([header('PaxHeader/x', 'x', Buffer.byteLength(pax)), data(pax), header('a', '0', 0), data('abc'), end()])).toEqual({ files: 1, bytes: 3 })
  })

  it.each([
    ['symbolic link', header('link', '2', 0, { linkname: '/etc/passwd' })],
    ['hard link', header('hard', '1', 0, { linkname: 'package.json' })],
    ['character device', header('tty', '3')],
    ['block device', header('sda', '4')],
    ['FIFO', header('pipe', '6')],
    ['global pax header', header('g', 'g')],
  ])('refuses a %s', (what, h) => {
    expect(() => scan([h, end()])).toThrow(UnsafeTarballError)
    expect(() => scan([h, end()])).toThrow(new RegExp(what))
  })

  it.each([
    ['/etc/cron.d/x', /absolute/],
    ['../outside.js', /\.\./],
    ['src/../../outside.js', /\.\./],
  ])('refuses the path %s', (name, why) => {
    expect(() => scan([...file(name, 'x'), end()])).toThrow(why)
  })

  it('refuses a pax path that escapes the folder', () => {
    const pax = paxRecord('path', '../../root/.ssh/authorized_keys')
    expect(() => scan([header('PaxHeader/x', 'x', Buffer.byteLength(pax)), data(pax), ...file('innocent', 'k'), end()])).toThrow(/\.\./)
  })

  it('refuses a corrupt header (bad checksum) and a truncated archive', () => {
    expect(() => scan([header('a', '0', 0, { badChecksum: true }), end()])).toThrow(/checksum/)
    expect(() => scan([header('a', '0', 600), data('x'.repeat(100))])).toThrow(/truncated/)
  })

  it('enforces the snapshot limits (files and unpacked bytes)', () => {
    const s = new TarScanner({ files: 2, bytes: 10 })
    s.push(Buffer.concat([...file('a', 'x'), ...file('b', 'y')]))
    expect(() => s.push(Buffer.concat(file('c', 'z')))).toThrow(/more than 2 files/)
    const t = new TarScanner({ files: 100, bytes: 10 })
    expect(() => t.push(Buffer.concat(file('a', 'x'.repeat(11))))).toThrow(/more than 10 bytes/)
    expect(SNAPSHOT_LIMITS).toEqual({ files: 20_000, bytes: 200 * 1024 * 1024 })
  })
})

/** macOS tar would add ._ metadata files otherwise. */
const noAppleDouble = { ...process.env, COPYFILE_DISABLE: '1' }

describe('scanTarball (a gzip file on disk)', () => {
  let dir: string | null = null
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('scans a hand-built gzip tarball', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ee-pvtar-'))
    await writeFile(join(dir, 'a.tar.gz'), gzipSync(Buffer.concat([...file('package.json', '{}'), end()])))
    await expect(scanTarball(join(dir, 'a.tar.gz'))).resolves.toEqual({ files: 1, bytes: 2 })
  })

  it('refuses something that is not gzip', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ee-pvtar-'))
    await writeFile(join(dir, 'a.tar.gz'), 'not a tarball')
    await expect(scanTarball(join(dir, 'a.tar.gz'))).rejects.toThrow(UnsafeTarballError)
  })

  it('accepts what the system tar writes for a folder with long paths, refuses one with a symlink', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ee-pvtar-'))
    const src = join(dir, 'src')
    const deep = join(src, 'a'.repeat(60), 'b'.repeat(60))
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, `${'c'.repeat(80)}.js`), 'export {}\n')
    await writeFile(join(src, 'package.json'), '{"scripts":{"dev":"vite"}}')
    execFileSync('tar', ['-czf', join(dir, 'ok.tar.gz'), '-C', src, '.'], { env: noAppleDouble })
    const ok = await scanTarball(join(dir, 'ok.tar.gz'))
    expect(ok.files).toBe(2)
    await symlink('/etc/passwd', join(src, 'passwd'))
    execFileSync('tar', ['-czf', join(dir, 'bad.tar.gz'), '-C', src, '.'], { env: noAppleDouble })
    await expect(scanTarball(join(dir, 'bad.tar.gz'))).rejects.toThrow(/symbolic link/)
  })
})
