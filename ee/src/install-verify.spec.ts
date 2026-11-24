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
import { BACKUP_PLACEHOLDER, sha256Hex } from './release-key.ts'

const INSTALL = readFileSync(new URL('../install.sh', import.meta.url), 'utf8')
const BLOCK = /# BEGIN SIGNED RELEASE[^\n]*\n([\s\S]*?)# END SIGNED RELEASE/.exec(INSTALL)?.[1] ?? ''
const KEY_BLOCK = /# BEGIN RELEASE PUBLIC KEY[^\n]*\n[\s\S]*?# END RELEASE PUBLIC KEY/
const BACKUP_KEY_BLOCK = /# BEGIN RELEASE BACKUP PUBLIC KEY[^\n]*\n[\s\S]*?# END RELEASE BACKUP PUBLIC KEY/

/** macOS's LibreSSL cannot do raw Ed25519; OpenSSL 3 (Debian 13, Ubuntu 24.04, Homebrew) can. */
const rawEd25519 = (() => {
  const d = mkdtempSync(join(tmpdir(), 'ee-ossl-'))
  const r = spawnSync('sh', ['-c', 'openssl genpkey -algorithm ed25519 -out k && echo x > m && openssl pkeyutl -sign -rawin -inkey k -in m -out s'], { cwd: d })
  return r.status === 0
})()

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
const backupPair = generateKeyPairSync('ed25519')
const BACKUP_PUB = backupPair.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim()
const heredoc = (pem: string) => `  cat <<'PEM'\n${pem}\nPEM`
/** The block with the given current key (null: the placeholder) and backup key (null: the backup placeholder). */
const withKey = (pem: string | null, backupPem: string | null = null) =>
  BLOCK.replace(KEY_BLOCK, pem === null ? `  echo 'PLACEHOLDER: no release signing key yet'` : heredoc(pem)).replace(
    BACKUP_KEY_BLOCK,
    backupPem === null ? `  echo '${BACKUP_PLACEHOLDER}'` : heredoc(backupPem),
  )

function release(files: Record<string, string>, opts: { tamper?: boolean; key?: KeyObject } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ee-rel-'))
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
  const sums = Object.entries(files).map(([n, c]) => `${sha256Hex(c)}  ${n}\n`).join('')
  writeFileSync(join(dir, 'SHA256SUMS'), opts.tamper ? `${sums}${'0'.repeat(64)}  extra\n` : sums)
  writeFileSync(join(dir, 'SHA256SUMS.sig'), `${sign(null, Buffer.from(sums), opts.key ?? privateKey).toString('base64')}\n`)
  return dir
}

function run(dir: string, script: string, pem: string | null = PUB, backupPem: string | null = null) {
  const r = spawnSync('sh', ['-c', `set -eu\n${withKey(pem, backupPem)}\nverify_release "$D"\n${script}\necho OK`], {
    env: { ...process.env, D: dir },
    encoding: 'utf8',
  })
  return { ok: r.status === 0 && r.stdout.includes('OK'), err: r.stderr }
}

it('install.sh has the signed-release block with the key markers scripts/release-key.sh writes', () => {
  expect(BLOCK).toMatch(KEY_BLOCK)
  expect(BLOCK).toMatch(BACKUP_KEY_BLOCK)
  expect(spawnSync('sh', ['-n', '-c', BLOCK]).status).toBe(0)
})

it('the embedded backup key is the same placeholder release-key.ts uses, or a public key', () => {
  const embedded = BACKUP_KEY_BLOCK.exec(BLOCK)?.[0] ?? ''
  expect(embedded.includes(`echo '${BACKUP_PLACEHOLDER}'`) || embedded.includes('-----BEGIN PUBLIC KEY-----')).toBe(true)
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
  it('trusts the backup key: a release signed by it installs', () => {
    const d = release({ 'ee.mjs': 'code' }, { key: backupPair.privateKey })
    expect(run(d, 'signed "$D/ee.mjs" ee.mjs', PUB, BACKUP_PUB)).toEqual({ ok: true, err: '' })
    expect(run(release({ 'ee.mjs': 'code' }), 'signed "$D/ee.mjs" ee.mjs', PUB, BACKUP_PUB)).toEqual({ ok: true, err: '' })
  })
  it('refuses a stranger even with a backup key embedded', () => {
    const r = run(release({ 'ee.mjs': 'code' }, { key: generateKeyPairSync('ed25519').privateKey }), '', PUB, BACKUP_PUB)
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/not signed by the eigenEnterprise release key/)
  })
  it('ignores the placeholder backup: the current key still verifies, the backup key does not', () => {
    expect(run(release({ 'ee.mjs': 'code' }), 'signed "$D/ee.mjs" ee.mjs', PUB, null)).toEqual({ ok: true, err: '' })
    const r = run(release({ 'ee.mjs': 'code' }, { key: backupPair.privateKey }), '', PUB, null)
    expect(r.ok).toBe(false)
    expect(r.err).toMatch(/not signed/)
  })
  it('fails loud on a backup that is neither a public key nor the placeholder', () => {
    const r = spawnSync('sh', ['-c', `set -eu\n${BLOCK.replace(BACKUP_KEY_BLOCK, "  echo ''")}\nverify_release "$D"\necho OK`], {
      env: { ...process.env, D: release({ 'ee.mjs': 'code' }) },
      encoding: 'utf8',
    })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('the backup release key is neither a public key nor the placeholder')
  })
  it('the backup never stands in for a missing current key', () => {
    const r = run(release({ 'ee.mjs': 'code' }, { key: backupPair.privateKey }), '', null, BACKUP_PUB)
    expect(r.ok).toBe(false)
    expect(r.err).toContain('this build has no release signing key (run scripts/release-key.sh)')
  })
  it('fails loud with the placeholder key', () => {
    const r = run(release({ 'ee.mjs': 'code' }), '', null)
    expect(r.ok).toBe(false)
    expect(r.err).toContain('this build has no release signing key (run scripts/release-key.sh)')
  })
})
