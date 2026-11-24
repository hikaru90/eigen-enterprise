import { execFileSync, spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../contracts/fixtures/module-hub-test-key.ts'
import { keyId } from '../../contracts/module-receipt.ts'
import { settingsSchema } from './company-repo.ts'
import {
  DEFAULT_MODULE_HUB,
  HUB_BACKUP_KEY_PLACEHOLDER,
  HUB_KEY_PLACEHOLDER,
  MODULE_HUB_BACKUP_PUBLIC_KEY_SPKI,
  MODULE_HUB_PUBLIC_KEY_SPKI,
  NO_HUB_KEY_MESSAGE,
  OFFICIAL_MODULE_HUB,
  checkHubKey,
  embeddedHubKeys,
  moduleHubEnv,
  parseModuleHubFlag,
  parseModuleHubKeyFlags,
  resolveModuleHub,
  trustedHubKeys,
} from './hub-key.ts'

const spki = () => generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const A = spki()
const B = spki()

describe('module hub keys (hub-key.ts)', () => {
  it('a key is base64 DER SPKI of an Ed25519 key, and never the repo test key', () => {
    expect(checkHubKey(A)).toBe(A)
    expect(() => checkHubKey('not base64!')).toThrow(/base64 DER SPKI/)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(() => checkHubKey(rsa)).toThrow(/is rsa, not ed25519/)
    expect(() => checkHubKey(TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI)).toThrow(/public TEST key/)
  })

  it('the embedded keys: current required, backup optional, never the same key', () => {
    expect(() => embeddedHubKeys(HUB_KEY_PLACEHOLDER, HUB_BACKUP_KEY_PLACEHOLDER)).toThrow(NO_HUB_KEY_MESSAGE)
    expect(embeddedHubKeys(A, HUB_BACKUP_KEY_PLACEHOLDER)).toEqual([A])
    expect(embeddedHubKeys(A, B)).toEqual([A, B])
    expect(() => embeddedHubKeys(A, A)).toThrow(/backup module hub key is the current key/)
    expect(() => embeddedHubKeys(A, 'garbage')).toThrow(/embedded backup module hub key is not a public key/)
    expect(() => embeddedHubKeys(A, 'not base64!')).toThrow(/base64 DER SPKI/)
  })

  it('this build embeds no test key (placeholder or a real Ed25519 key)', () => {
    for (const [k, placeholder] of [
      [MODULE_HUB_PUBLIC_KEY_SPKI, HUB_KEY_PLACEHOLDER],
      [MODULE_HUB_BACKUP_PUBLIC_KEY_SPKI, HUB_BACKUP_KEY_PLACEHOLDER],
    ] as const) {
      if (k !== placeholder) expect(checkHubKey(k)).toBe(k)
    }
  })

  it('trust: keys given at bootstrap replace the embedded ones; the official hub falls back to them; another hub needs its own', () => {
    expect(trustedHubKeys({ origin: 'https://hub.example.com', publicKeys: [A] })).toEqual([A])
    expect(trustedHubKeys({ origin: OFFICIAL_MODULE_HUB, publicKeys: [B] }, () => [A])).toEqual([B])
    expect(trustedHubKeys({ origin: OFFICIAL_MODULE_HUB, publicKeys: [] }, () => [A])).toEqual([A])
    expect(() => trustedHubKeys({ origin: 'https://hub.example.com', publicKeys: [] })).toThrow(/has no key: run ee bootstrap --module-hub https:\/\/hub.example.com --module-hub-key/)
    // A key that reached the company repo some other way is still checked.
    expect(() => trustedHubKeys({ origin: OFFICIAL_MODULE_HUB, publicKeys: [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI] })).toThrow(/TEST key/)
  })
})

describe('settings.moduleHub and the bootstrap flags (root only, never a control verb)', () => {
  it('companies from before modules get the official hub with the embedded keys', () => {
    expect(settingsSchema.parse({ consoleHost: 'os.example.com' }).moduleHub).toEqual({ origin: OFFICIAL_MODULE_HUB, publicKeys: [] })
    expect(DEFAULT_MODULE_HUB.origin).toBe('https://os.cerberusblue.com')
  })

  it('--module-hub: an https origin (http only for a local test host)', () => {
    expect(parseModuleHubFlag('https://hub.example.com')).toBe('https://hub.example.com')
    expect(parseModuleHubFlag('http://127.0.0.1:5199')).toBe('http://127.0.0.1:5199')
    expect(parseModuleHubFlag('http://hub.ee.test')).toBe('http://hub.ee.test')
    expect(() => parseModuleHubFlag('http://hub.example.com')).toThrow(/must use https/)
    expect(() => parseModuleHubFlag('https://hub.example.com/api')).toThrow(/origin only/)
    expect(() => parseModuleHubFlag('hub')).toThrow(/must be an origin/)
  })

  it('--module-hub-key: at most two different Ed25519 keys', () => {
    expect(parseModuleHubKeyFlags([A, B])).toEqual([A, B])
    expect(() => parseModuleHubKeyFlags([A, A])).toThrow(/same key twice/)
    expect(() => parseModuleHubKeyFlags([A, B, spki()])).toThrow(/at most two/)
    expect(() => parseModuleHubKeyFlags([TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI])).toThrow(/TEST key/)
  })

  it('a plain re-run keeps the hub; flags win; moving hubs drops the old keys and needs new ones', () => {
    const stored = { origin: 'https://hub.example.com', publicKeys: [A] }
    expect(resolveModuleHub({}, stored)).toEqual(stored)
    expect(resolveModuleHub({ keys: [B] }, stored)).toEqual({ origin: 'https://hub.example.com', publicKeys: [B] })
    expect(resolveModuleHub({ origin: OFFICIAL_MODULE_HUB }, stored)).toEqual({ origin: OFFICIAL_MODULE_HUB, publicKeys: [] })
    expect(() => resolveModuleHub({ origin: 'https://other.example.com' }, stored)).toThrow(/has no key: pass --module-hub-key/)
    expect(resolveModuleHub({ origin: 'https://other.example.com', keys: [B] }, stored)).toEqual({ origin: 'https://other.example.com', publicKeys: [B] })
  })

  it('MODULE_HUB_URL is rendered into the os env', () => {
    expect(moduleHubEnv({ ORIGIN: 'https://os.example.com' }, { origin: 'https://hub.example.com', publicKeys: [A] })).toEqual({
      ORIGIN: 'https://os.example.com',
      MODULE_HUB_URL: 'https://hub.example.com',
    })
  })
})

/** OpenSSL 3+ (raw Ed25519), as scripts/hub-key.sh needs; macOS LibreSSL is not enough. */
function openssl3(): string | null {
  for (const bin of ['/opt/homebrew/opt/openssl@3/bin', '/usr/local/opt/openssl@3/bin', '/usr/bin', '/opt/homebrew/bin']) {
    const r = spawnSync(join(bin, 'openssl'), ['version'], { encoding: 'utf8' })
    if (r.status === 0 && /^OpenSSL ([3-9]|[1-9][0-9]+)\./.test(r.stdout)) return bin
  }
  return null
}
const OPENSSL = openssl3()

describe.skipIf(OPENSSL === null)('scripts/hub-key.sh (current + backup, modelled on release-key.sh)', () => {
  function sandbox() {
    const root = mkdtempSync(join(tmpdir(), 'hub-key-'))
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'ee', 'src'), { recursive: true })
    mkdirSync(join(root, 'home'))
    copyFileSync(join(import.meta.dirname, '../../scripts/hub-key.sh'), join(root, 'scripts', 'hub-key.sh'))
    copyFileSync(join(import.meta.dirname, 'hub-key.ts'), join(root, 'ee', 'src', 'hub-key.ts'))
    const run = (...args: string[]) =>
      spawnSync('sh', [join(root, 'scripts', 'hub-key.sh'), ...args], { encoding: 'utf8', env: { PATH: `${OPENSSL}:/usr/bin:/bin`, HOME: join(root, 'home') } })
    const embedded = (name: string) => {
      const m = new RegExp(`export const ${name}: string = '([A-Za-z0-9+/=]+)'`).exec(readFileSync(join(root, 'ee', 'src', 'hub-key.ts'), 'utf8'))
      return m?.[1] ?? null
    }
    return { root, run, embedded }
  }

  it('writes the private key (0600), embeds the SPKI between the markers, and never overwrites the key', () => {
    const s = sandbox()
    try {
      const first = s.run()
      expect(first.status, first.stderr).toBe(0)
      const pem = join(s.root, 'home', '.config', 'eigenenterprise', 'module-hub-signing.pem')
      expect(statSync(pem).mode & 0o777).toBe(0o600)
      const current = s.embedded('MODULE_HUB_PUBLIC_KEY_SPKI')!
      expect(checkHubKey(current)).toBe(current)
      // The embedded key is the private key's public half.
      const der = execFileSync(join(OPENSSL!, 'openssl'), ['pkey', '-in', pem, '-pubout', '-outform', 'DER'])
      expect(keyId(current)).toBe(keyId(der.toString('base64')))
      expect(first.stdout).toContain('MODULE_HUB_SIGNING_KEY')
      expect(s.run().status).not.toBe(0)
      expect(s.run().stderr).toMatch(/already exists/)
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  })

  it('--backup embeds a second key once; a second backup is refused even after the local copy is gone', () => {
    const s = sandbox()
    try {
      expect(s.run().status).toBe(0)
      const backup = s.run('--backup')
      expect(backup.status, backup.stderr).toBe(0)
      const keys = embeddedHubKeys(s.embedded('MODULE_HUB_PUBLIC_KEY_SPKI')!, s.embedded('MODULE_HUB_BACKUP_PUBLIC_KEY_SPKI')!)
      expect(keys).toHaveLength(2)
      expect(backup.stdout).toContain('must NOT go to the hub box')
      rmSync(join(s.root, 'home', '.config', 'eigenenterprise', 'module-hub-backup-signing.pem'))
      const again = s.run('--backup')
      expect(again.status).not.toBe(0)
      expect(again.stderr).toMatch(/already embeds a backup module hub key/)
      expect(existsSync(join(s.root, 'home', '.config', 'eigenenterprise', 'module-hub-backup-signing.pem'))).toBe(false)
    } finally {
      rmSync(s.root, { recursive: true, force: true })
    }
  })
})
