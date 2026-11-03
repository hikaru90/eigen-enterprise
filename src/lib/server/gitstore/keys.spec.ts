import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { identityToRecipient } from 'age-encryption'
import { describe, expect, it } from 'vitest'
import { GitEngine } from './engine'
import {
  ageDecrypt,
  ageEncrypt,
  CompanyKeyError,
  deriveBackupKey,
  generateRootKey,
  KeyRing,
  recoveryCodeFromIdentity,
  RECIPIENTS_PATH,
  rootKeyFromRecoveryCode,
  SealedRootKeyStore,
} from './keys'
import { secretPath } from './layout'
import { tempDir } from './test-helpers'

const AUTHOR = { name: 'Owner', email: 'owner@acme.test' }

/** The reference `age` CLI, when present (AGE_CLI=/path/to/age or `age` on PATH). */
function ageCli(): string | null {
  const explicit = process.env.AGE_CLI
  if (explicit && existsSync(explicit)) return explicit
  try {
    execFileSync('age', ['--version'])
    return 'age'
  } catch {
    return null
  }
}

describe('company root key + recovery code', () => {
  it('round-trips through the recovery code (grouped, prefixed, tolerant of case/spacing/look-alikes)', async () => {
    const root = await generateRootKey()
    expect(root.identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]+$/)
    expect(root.recoveryCode).toMatch(/^EE1(-[0-9A-Z]{1,5}){11}$/)
    expect(await rootKeyFromRecoveryCode(root.recoveryCode)).toEqual({
      identity: root.identity,
      recipient: root.recipient,
    })
    const sloppy = ` ${root.recoveryCode.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `
    expect((await rootKeyFromRecoveryCode(sloppy)).identity).toBe(root.identity)
  })

  it('the checksum catches a typo', async () => {
    const root = await generateRootKey()
    const chars = root.recoveryCode.split('')
    const i = 6
    chars[i] = chars[i] === 'A' ? 'B' : 'A'
    await expect(rootKeyFromRecoveryCode(chars.join(''))).rejects.toThrow(/typo|checksum/)
    await expect(rootKeyFromRecoveryCode('XX1-ABC')).rejects.toThrow(CompanyKeyError)
  })

  it('one code for the company: the backup key is derived from the root key, deterministically', async () => {
    const root = await generateRootKey()
    const restored = await rootKeyFromRecoveryCode(root.recoveryCode)
    expect(deriveBackupKey(root.identity).equals(deriveBackupKey(restored.identity))).toBe(true)
    expect(deriveBackupKey(root.identity)).toHaveLength(32)
    expect(recoveryCodeFromIdentity(restored.identity)).toBe(root.recoveryCode)
  })

  it('sealed on the server under TENANT_MASTER_KEY (0600); wrong master key fails; never replaced by another key', async () => {
    const dir = tempDir('seal')
    const root = await generateRootKey()
    const store = new SealedRootKeyStore(dir, 'master-1')
    expect(await store.load()).toBeNull()
    await store.save(root)
    expect((await store.load())?.identity).toBe(root.identity)
    const raw = await readFile(join(dir, 'root.sealed'), 'utf8')
    expect(raw).not.toContain(root.identity)
    expect(
      execFileSync('stat', ['-f', '%Lp', join(dir, 'root.sealed')])
        .toString()
        .trim(),
    ).toBe('600')
    await expect(new SealedRootKeyStore(dir, 'master-2').load()).rejects.toThrow()
    await expect(store.save(await generateRootKey())).rejects.toThrow(/refusing/)
  })
})

describe('scope keys in the repo', () => {
  async function repoWithKeys() {
    const engine = new GitEngine({ dir: tempDir('keys') })
    await engine.open()
    const root = await generateRootKey()
    const ring = new KeyRing((p) => engine.readWorking(p), root)
    const write = async (changes: Awaited<ReturnType<KeyRing['initRoot']>>) => {
      if (changes.length)
        await (
          await engine.stage('keys', changes, { author: AUTHOR, message: 'keys' })
        ).committed
    }
    await write(await ring.initRoot())
    return { engine, root, ring, write }
  }

  it('encrypted-scope demo: secrets/test/x.age is unreadable without the root key, readable after a fresh-server restore with the recovery code', async () => {
    const { engine, root, ring, write } = await repoWithKeys()
    await write(await ring.ensureScope('secrets/test'))
    const path = secretPath('test', 'x')
    expect(path).toBe('secrets/test/x.age')
    await write([{ path, content: await ring.encrypt('secrets/test', 'sk-live-123') }])

    const bytes = (await engine.readWorking(path))!
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('sk-live-123')
    expect(Buffer.from(bytes).subarray(0, 21).toString()).toBe('age-encryption.org/v1')
    // the recipients file is public: no private key material
    const recipients = Buffer.from((await engine.readWorking(RECIPIENTS_PATH))!).toString()
    expect(recipients).not.toMatch(/AGE-SECRET-KEY/)

    // a git reader without the root key
    const noKey = new KeyRing((p) => engine.readWorking(p), null)
    await expect(noKey.decrypt('secrets/test', bytes)).rejects.toThrow(/root key is not available/)
    const stranger = await generateRootKey()
    await expect(
      new KeyRing((p) => engine.readWorking(p), stranger).decrypt('secrets/test', bytes),
    ).rejects.toThrow()

    // fresh server: clone the repo, type the recovery code
    const clone = tempDir('clone')
    execFileSync('git', ['clone', '-q', engine.dir, clone])
    const fresh = new GitEngine({ dir: clone })
    await fresh.open()
    const restored = await rootKeyFromRecoveryCode(root.recoveryCode)
    const sealed = new SealedRootKeyStore(tempDir('fresh-keys'), 'new-server-master')
    await sealed.save(restored)
    const ring2 = new KeyRing((p) => fresh.readWorking(p), await sealed.load())
    expect(
      Buffer.from(await ring2.decrypt('secrets/test', (await fresh.readWorking(path))!)).toString(),
    ).toBe('sk-live-123')
    // and a repo encrypted to another root refuses to be adopted silently
    await expect(new KeyRing((p) => fresh.readWorking(p), stranger).initRoot()).rejects.toThrow(
      /different company root key/,
    )
  })

  it('rotation: new generation, current files re-encrypted to it, old history still decryptable', async () => {
    const { engine, ring, write } = await repoWithKeys()
    await write(await ring.ensureScope('channel/c1'))
    const path = 'messages/c1/2026-11-03.jsonl.age'
    const v1 = await ring.encrypt('channel/c1', 'old line\n')
    const before = (await ring.recipients())!.scopes['channel/c1']!
    const changes = await ring.rotateScope('channel/c1', new Map([[path, v1]]))
    await write(changes)
    const after = (await ring.recipients())!.scopes['channel/c1']!
    expect(after.generation).toBe(2)
    expect(after.recipient).not.toBe(before.recipient)
    const rotated = (await engine.readWorking(path))!
    // current file is encrypted to the NEW recipient only
    const gen2 = (await ring.scopeIdentities('channel/c1'))[0]!
    expect(await identityToRecipient(gen2)).toBe(after.recipient)
    expect(Buffer.from(await ageDecrypt([gen2], rotated)).toString()).toBe('old line\n')
    // history (the pre-rotation ciphertext) still opens through the keyring
    expect(Buffer.from(await ring.decrypt('channel/c1', v1)).toString()).toBe('old line\n')
    expect(await engine.readWorking('.keys/scopes/channel/c1/1.age')).not.toBeNull()
    expect(await engine.readWorking('.keys/scopes/channel/c1/2.age')).not.toBeNull()
  })

  const cli = ageCli()
  it.skipIf(!cli)(
    'interop: the age CLI decrypts our files and we decrypt the CLI’s (standard .age, no lock-in)',
    async () => {
      const dir = tempDir('cli')
      const root = await generateRootKey()
      const idFile = join(dir, 'key.txt')
      writeFileSync(idFile, `${root.identity}\n`)
      const ours = join(dir, 'ours.age')
      writeFileSync(ours, await ageEncrypt(root.recipient, 'from typescript'))
      expect(execFileSync(cli!, ['-d', '-i', idFile, ours]).toString()).toBe('from typescript')
      const theirs = execFileSync(cli!, ['-r', root.recipient], { input: 'from the age CLI' })
      expect(Buffer.from(await ageDecrypt([root.identity], theirs)).toString()).toBe(
        'from the age CLI',
      )
    },
  )
})
