import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, describe, expect, it } from 'vitest'
import {
  BUNDLE_LIMITS,
  bundleFileText,
  bundleFromDirectory,
  createBundle,
  forbiddenBundlePath,
  ModuleBundleError,
  readBundle,
  type BundleFile,
} from './module-bundle'

const HELLO = join(import.meta.dirname, 'fixtures/modules/hello')
const COMMIT_TIME = new Date('2026-11-24T12:00:00Z')
const enc = new TextEncoder()
const f = (path: string, text = path, executable = false): BundleFile => ({
  path,
  content: enc.encode(text),
  executable,
})
const base = [f('module.yaml', 'manifest: eigen.module/1\n'), f('LICENSE', 'Apache')]
const problemsOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof ModuleBundleError) return err.problems
    throw err
  }
  return []
}

const tmp: string[] = []
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
})

describe('bundle determinism', () => {
  it('gives the same bytes and sha256 across runs and input orders', async () => {
    const files = [...base, f('src/a.js'), f('src/b/c.js'), f('bin/run', '#!/bin/sh', true)]
    const one = createBundle(files, COMMIT_TIME)
    const two = createBundle([...files].reverse(), COMMIT_TIME)
    expect(two.sha256).toBe(one.sha256)
    expect(Buffer.compare(one.bytes, two.bytes)).toBe(0)
    const a = await bundleFromDirectory(HELLO, COMMIT_TIME)
    const b = await bundleFromDirectory(HELLO, COMMIT_TIME)
    expect(b.sha256).toBe(a.sha256)
  })

  it('changes with the commit time, a byte, or the executable bit', () => {
    const one = createBundle(base, COMMIT_TIME).sha256
    expect(createBundle(base, new Date('2026-11-24T12:00:01Z')).sha256).not.toBe(one)
    expect(createBundle([base[0]!, f('LICENSE', 'Apachf')], COMMIT_TIME).sha256).not.toBe(one)
    expect(createBundle([base[0]!, f('LICENSE', 'Apache', true)], COMMIT_TIME).sha256).not.toBe(one)
  })

  it('writes gzip mtime 0 and a platform-free header', () => {
    const { bytes } = createBundle(base, COMMIT_TIME)
    expect([...bytes.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff])
  })

  it('writes a tar that system tar lists: sorted, dirs 0755, files 0644/0755, 0:0, commit mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    tmp.push(dir)
    const long = `deep/${'d'.repeat(120)}/${'n'.repeat(120)}.js`
    const { bytes } = createBundle(
      [...base, f('src/z.js'), f('src/a.js'), f('run', 'x', true), f(long)],
      COMMIT_TIME,
    )
    writeFileSync(join(dir, 'b.tar.gz'), bytes)
    const listing = execFileSync('tar', ['-tvzf', join(dir, 'b.tar.gz')], { encoding: 'utf8' })
    const names = execFileSync('tar', ['-tzf', join(dir, 'b.tar.gz')], { encoding: 'utf8' })
      .trim()
      .split('\n')
    expect(names).toEqual([
      'LICENSE',
      'deep/',
      `deep/${'d'.repeat(120)}/`,
      long,
      'module.yaml',
      'run',
      'src/',
      'src/a.js',
      'src/z.js',
    ])
    expect(listing).toMatch(/^drwxr-xr-x/m)
    expect(listing).toMatch(/^-rwxr-xr-x .* run$/m)
    expect(listing).toMatch(/^-rw-r--r-- .* LICENSE$/m)
  })
})

describe('readBundle', () => {
  it('reads back what createBundle wrote, in order, with contents', async () => {
    const { bytes, sha256 } = await bundleFromDirectory(HELLO, COMMIT_TIME)
    const read = readBundle(bytes)
    expect(read.sha256).toBe(sha256)
    expect(read.entries.map((e) => e.path)).toEqual([
      'LICENSE',
      'index.mjs',
      'module.yaml',
      'package.json',
      'test.mjs',
    ])
    expect(bundleFileText(read.entries, 'module.yaml')).toContain('id: hello')
    expect(bundleFileText(read.entries, 'missing')).toBeNull()
  })

  it('reads pax long paths and directories', () => {
    const long = `${'p'.repeat(200)}/file.txt`
    const read = readBundle(createBundle([...base, f(long, 'long')], COMMIT_TIME).bytes)
    expect(read.entries.map((e) => [e.type, e.path])).toContainEqual(['file', long])
    expect(read.entries.map((e) => [e.type, e.path])).toContainEqual(['directory', 'p'.repeat(200)])
  })

  it('refuses a tar that is not ours: links, bad modes, foreign owners', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    tmp.push(dir)
    const src = join(dir, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'module.yaml'), 'x')
    writeFileSync(join(src, 'LICENSE'), 'x')
    symlinkSync('/etc/passwd', join(src, 'link'))
    execFileSync('tar', ['-czf', join(dir, 'b.tar.gz'), '-C', src, '.'])
    const bytes = readFileSync(join(dir, 'b.tar.gz'))
    expect(problemsOf(() => readBundle(bytes)).length).toBeGreaterThan(0)
  })

  it('refuses garbage, truncation, and a tampered header', () => {
    expect(problemsOf(() => readBundle(Buffer.from('not gzip')))[0]!.message).toMatch(/gzip/)
    const { bytes } = createBundle(base, COMMIT_TIME)
    expect(
      problemsOf(() => readBundle(bytes.subarray(0, bytes.byteLength - 20))).length,
    ).toBeGreaterThan(0)
    const tar = gunzipSync(bytes)
    tar[0] = tar[0]! ^ 1
    expect(problemsOf(() => readBundle(gzipSync(tar)))[0]!.message).toMatch(/checksum/)
  })

  it('refuses a bundle over the packed limit before unpacking', () => {
    expect(
      problemsOf(() => readBundle(Buffer.alloc(BUNDLE_LIMITS.packedBytes + 1)))[0]!.message,
    ).toMatch(/packed/)
  })
})

describe('required and forbidden entries, limits', () => {
  it('requires module.yaml and LICENSE', () => {
    expect(problemsOf(() => createBundle([f('module.yaml')], COMMIT_TIME))).toEqual([
      { path: 'LICENSE', message: 'is required' },
    ])
    expect(problemsOf(() => createBundle([f('LICENSE')], COMMIT_TIME))).toEqual([
      { path: 'module.yaml', message: 'is required' },
    ])
  })

  it.each([
    'node_modules/x/index.js',
    'lib/node_modules/y.js',
    '.git/config',
    '.env',
    '.env.local',
    'config/.env.production',
    'certs/server.pem',
    'tls.key',
    'id_rsa',
    'keys/id_ed25519.pub',
  ])('refuses %s', (path) => {
    expect(forbiddenBundlePath(path)).not.toBeNull()
    expect(
      problemsOf(() => createBundle([...base, f(path)], COMMIT_TIME)).map((p) => p.path),
    ).toContain(path)
  })

  it.each(['src/env.ts', 'keyboard.js', 'docs/identity.md', 'environment.json'])(
    'allows %s',
    (path) => {
      expect(forbiddenBundlePath(path)).toBeNull()
    },
  )

  it.each(['/abs', '../up', 'a/../b', 'a//b', './a'])('refuses the path %s', (path) => {
    expect(
      problemsOf(() => createBundle([...base, f(path)], COMMIT_TIME)).map((p) => p.path),
    ).toContain(path)
  })

  it('needs a lockfile when package.json declares dependencies', () => {
    const pkg = f('package.json', JSON.stringify({ dependencies: { zod: '^4.0.0' } }))
    expect(problemsOf(() => createBundle([...base, pkg], COMMIT_TIME)).map((p) => p.path)).toEqual([
      'package-lock.json',
    ])
    expect(
      problemsOf(() => createBundle([...base, pkg, f('package-lock.json', '{}')], COMMIT_TIME)),
    ).toEqual([])
    expect(problemsOf(() => createBundle([...base, f('package.json', '{}')], COMMIT_TIME))).toEqual(
      [],
    )
  })

  it('caps files and unpacked bytes, collecting every problem', () => {
    const many = Array.from({ length: BUNDLE_LIMITS.files }, (_, i) => f(`f/${i}`, ''))
    const problems = problemsOf(() =>
      createBundle(
        [...base, ...many, { path: 'big', content: new Uint8Array(BUNDLE_LIMITS.unpackedBytes) }],
        COMMIT_TIME,
      ),
    )
    expect(problems.map((p) => p.message).join('\n')).toMatch(/files, at most 5000/)
    expect(problems.map((p) => p.message).join('\n')).toMatch(/unpacked, at most/)
  })

  it('refuses a duplicate, and a path that is both a file and a directory', () => {
    expect(
      problemsOf(() => createBundle([...base, f('a'), f('a')], COMMIT_TIME)).map((p) => p.message),
    ).toContain('listed twice')
    expect(
      problemsOf(() => createBundle([...base, f('a'), f('a/b')], COMMIT_TIME))[0]!.message,
    ).toMatch(/both/)
  })

  it('refuses links when bundling a directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'))
    tmp.push(dir)
    writeFileSync(join(dir, 'module.yaml'), 'x')
    writeFileSync(join(dir, 'LICENSE'), 'x')
    symlinkSync('LICENSE', join(dir, 'COPYING'))
    await expect(bundleFromDirectory(dir, COMMIT_TIME)).rejects.toThrow(/links are never bundled/)
  })
})
