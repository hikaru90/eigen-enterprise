/**
 * Runs install.sh's signed-release block (verify_release + signed) in a real shell
 * with real openssl, against a throwaway Ed25519 key.
 */
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './release-key.ts'

const INSTALL = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const BLOCK = /# BEGIN SIGNED RELEASE[^\n]*\n([\s\S]*?)# END SIGNED RELEASE/.exec(INSTALL)?.[1] ?? ''
const KEY_BLOCK = /# BEGIN RELEASE PUBLIC KEY[^\n]*\n[\s\S]*?# END RELEASE PUBLIC KEY/

/** macOS's LibreSSL cannot do raw Ed25519; OpenSSL 3 (Debian 13, Ubuntu 24.04, Homebrew) can. */
const rawEd25519 = (() => {
  const d = mkdtempSync(join(tmpdir(), 'ee-ossl-'))
  const r = spawnSync('sh', ['-c', 'openssl genpkey -algorithm ed25519 -out k && echo x > m && openssl pkeyutl -sign -rawin -inkey k -in m -out s'], { cwd: d })
  return r.status === 0
})()

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
const withKey = (pem: string | null) =>
  BLOCK.replace(KEY_BLOCK, pem === null ? `  echo 'PLACEHOLDER: no release signing key yet'` : `  cat <<'PEM'\n${pem}\nPEM`)

function release(files: Record<string, string>, opts: { tamper?: boolean; key?: KeyObject } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ee-rel-'))
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
  const sums = Object.entries(files).map(([n, c]) => `${sha256Hex(c)}  ${n}\n`).join('')
  writeFileSync(join(dir, 'SHA256SUMS'), opts.tamper ? `${sums}${'0'.repeat(64)}  extra\n` : sums)
  writeFileSync(join(dir, 'SHA256SUMS.sig'), `${sign(null, Buffer.from(sums), opts.key ?? privateKey).toString('base64')}\n`)
  return dir
}

function run(dir: string, script: string, pem: string | null = PUB) {
  const r = spawnSync('sh', ['-c', `set -eu\n${withKey(pem)}\nverify_release "$D"\n${script}\necho OK`], {
    env: { ...process.env, D: dir },
    encoding: 'utf8',
  })
  return { ok: r.status === 0 && r.stdout.includes('OK'), err: r.stderr }
}

it('install.sh has the signed-release block with the key markers scripts/release-key.sh writes', () => {
  expect(BLOCK).toMatch(KEY_BLOCK)
  expect(spawnSync('sh', ['-n', '-c', BLOCK]).status).toBe(0)
})

describe.skipIf(!rawEd25519)('install.sh signed release (real openssl)', () => {
  it('accepts a signed release and its files', () => {
    const d = release({ LATEST: 'eigenenterprise-0.5.0-1bb02b405565\n', 'ee.mjs': 'code' })
    expect(run(d, 'signed "$D/ee.mjs" ee.mjs; signed "$D/LATEST" LATEST')).toEqual({ ok: true, err: '' })
  })
  it('refuses a tampered SHA256SUMS', () => {
    const r = run(release({ 'ee.mjs': 'code' }, { tamper: true }), '')
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/not signed by the eigenEnterprise release key/)
  })
  it('refuses a signature by another key', () => {
    const r = run(release({ 'ee.mjs': 'code' }, { key: generateKeyPairSync('ed25519').privateKey }), '')
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/not signed/)
  })
  it('refuses a changed file and a file the manifest does not list', () => {
    const d = release({ 'ee.mjs': 'code' })
    writeFileSync(join(d, 'ee.mjs'), 'evil')
    expect(run(d, 'signed "$D/ee.mjs" ee.mjs').err).toMatch(/checksum mismatch for ee.mjs/)
    expect(run(d, 'signed "$D/ee.mjs" other.tar.gz').err).toMatch(/does not list other.tar.gz/)
  })
  it('fails loud with the placeholder key', () => {
    const r = run(release({ 'ee.mjs': 'code' }), '', null)
    expect(r.ok).toBe(false)
    expect(r.err).toContain('this build has no release signing key (run scripts/release-key.sh)')
  })
})
