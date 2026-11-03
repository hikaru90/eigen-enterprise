import { createHash, hkdfSync } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { base32crockford, bech32 } from '@scure/base'
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from 'age-encryption'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'
import { canonicalYaml, parseYaml } from './canonical'
import { assertRepoPath, ENCRYPTED_SUFFIX, LAYOUT } from './layout'

/**
 * Company keys (plan/phase-git-native.md §3).
 *
 * - The **company root key** is an age X25519 identity (`AGE-SECRET-KEY-1…`).
 *   The owner gets it once as a **recovery code**: the 32 raw key bytes plus a
 *   2-byte checksum in Crockford base32, grouped by 5 (`EE1-XXXXX-…`). It is
 *   the ONE company recovery code: the backup key (plan/phase-backups.md) is
 *   derived from it (`deriveBackupKey`), so there is never a second code.
 * - Each **scope** (a secret scope, a private channel, a DM, a restricted
 *   folder) has its own X25519 data key. Its identity is stored in the repo
 *   at `.keys/scopes/<scope>/<generation>.age`, encrypted to the root
 *   recipient; `.keys/recipients.yaml` lists the root recipient and each
 *   scope's current generation + public recipient (no private keys).
 * - Files in a scope are standard `.age` files encrypted to the scope's
 *   current recipient — `age -d -i scope-identity.txt file.age` decrypts them.
 * - Rotation mints a new generation, re-encrypts the scope's current files
 *   and keeps older wrapped generations so git history stays decryptable.
 */

export const RECIPIENTS_PATH = `${LAYOUT.keys}recipients.yaml`
const RECOVERY_PREFIX = 'EE1'
const IDENTITY_HRP = 'AGE-SECRET-KEY-'

export class CompanyKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompanyKeyError'
  }
}

export type RootKey = { identity: string; recipient: string }

export async function generateRootKey(): Promise<RootKey & { recoveryCode: string }> {
  const identity = await generateX25519Identity()
  return {
    identity,
    recipient: await identityToRecipient(identity),
    recoveryCode: recoveryCodeFromIdentity(identity),
  }
}

function identityBytes(identity: string): Uint8Array {
  const decoded = bech32.decodeToBytes(identity.toLowerCase())
  if (decoded.prefix !== IDENTITY_HRP.toLowerCase() || decoded.bytes.length !== 32) {
    throw new CompanyKeyError('not an age X25519 identity')
  }
  return decoded.bytes
}

function checksum(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(RECOVERY_PREFIX).update(bytes).digest().subarray(0, 2)
}

export function recoveryCodeFromIdentity(identity: string): string {
  const bytes = identityBytes(identity)
  const body = base32crockford.encode(Uint8Array.from([...bytes, ...checksum(bytes)]))
  return [RECOVERY_PREFIX, ...(body.match(/.{1,5}/g) ?? [])].join('-')
}

/** Tolerant of case, spaces and Crockford look-alikes (O→0, I/L→1); the checksum catches typos. */
export async function rootKeyFromRecoveryCode(code: string): Promise<RootKey> {
  const cleaned = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (!cleaned.startsWith(RECOVERY_PREFIX))
    throw new CompanyKeyError(`a recovery code starts with ${RECOVERY_PREFIX}-`)
  const body = cleaned.slice(RECOVERY_PREFIX.length)
  let raw: Uint8Array
  try {
    raw = base32crockford.decode(body)
  } catch {
    throw new CompanyKeyError('the recovery code has characters that do not belong in it')
  }
  if (raw.length !== 34) throw new CompanyKeyError('the recovery code is too short or too long')
  const bytes = raw.subarray(0, 32)
  const sum = raw.subarray(32)
  const want = checksum(bytes)
  if (sum[0] !== want[0] || sum[1] !== want[1])
    throw new CompanyKeyError('the recovery code has a typo (checksum mismatch)')
  const identity = bech32.encodeFromBytes(IDENTITY_HRP, bytes).toUpperCase()
  return { identity, recipient: await identityToRecipient(identity) }
}

/** The backup encryption key (plan/phase-backups.md) — derived, so one recovery code covers both. */
export function deriveBackupKey(identity: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      identityBytes(identity),
      Buffer.alloc(0),
      'eigenEnterprise backup key v1',
      32,
    ),
  )
}

export async function ageEncrypt(
  recipient: string,
  plaintext: Uint8Array | string,
): Promise<Uint8Array> {
  const e = new Encrypter()
  e.addRecipient(recipient)
  return e.encrypt(plaintext)
}

export async function ageDecrypt(
  identities: readonly string[],
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  if (identities.length === 0) throw new CompanyKeyError('no identity to decrypt with')
  const d = new Decrypter()
  for (const id of identities) d.addIdentity(id)
  return d.decrypt(ciphertext)
}

// ---------------------------------------------------------------------------
// Root key sealed on the server
// ---------------------------------------------------------------------------

/**
 * Where the server keeps the root key: `COMPANY_KEYS_DIR`, else
 * `$EE_STATE_DIR/company-keys`, else refuse. The file is sealed (AES-256-GCM)
 * under TENANT_MASTER_KEY, which ee keeps in its sealed secret store and
 * injects into the os workload — so the chain is rooted in ee's store while
 * the app (the os workload, the one writer of the data repo) can generate the
 * key at setup and read it at boot without a round-trip through ee.
 */
export function resolveCompanyKeysDir(env: Record<string, string | undefined>): string {
  const explicit = env.COMPANY_KEYS_DIR?.trim()
  if (explicit) return explicit
  const substrate = env.EE_STATE_DIR?.trim()
  if (substrate) return join(substrate, 'company-keys')
  throw new Error(
    'Company keys are not configured: set COMPANY_KEYS_DIR, or run under the ee substrate which injects EE_STATE_DIR (keys then live at $EE_STATE_DIR/company-keys). Refusing to guess.',
  )
}

const SEAL_AAD = 'eigenEnterprise company root key v1'

function sealKey(masterKey: string): Buffer {
  if (!masterKey.trim())
    throw new CompanyKeyError('TENANT_MASTER_KEY is required to seal the company root key')
  return createHash('sha256').update(masterKey.trim(), 'utf8').digest()
}

export class SealedRootKeyStore {
  constructor(
    private readonly dir: string,
    private readonly masterKey: string,
  ) {}

  private get file(): string {
    return join(this.dir, 'root.sealed')
  }

  async load(): Promise<RootKey | null> {
    let blob: string
    try {
      blob = await readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const identity = decryptEnvelope(blob, sealKey(this.masterKey), SEAL_AAD)
    return { identity, recipient: await identityToRecipient(identity) }
  }

  /** Refuses to overwrite an existing, different root key (that would orphan every encrypted file). */
  async save(key: RootKey): Promise<void> {
    const existing = await this.load()
    if (existing && existing.identity !== key.identity) {
      throw new CompanyKeyError(
        'a different company root key is already sealed on this server; refusing to replace it',
      )
    }
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, encryptEnvelope(key.identity, sealKey(this.masterKey), SEAL_AAD), {
      mode: 0o600,
    })
    await chmod(tmp, 0o600)
    await rename(tmp, this.file)
  }
}

// ---------------------------------------------------------------------------
// Scope keys in the repo
// ---------------------------------------------------------------------------

export type RecipientsFile = {
  root: string
  scopes: Record<string, { generation: number; recipient: string }>
}

export type RepoBytesReader = (path: string) => Promise<Uint8Array | null>
export type FileChange = { path: string; content: string | Uint8Array | null }

const SCOPE = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/

export function assertScope(scope: string): string {
  if (!SCOPE.test(scope)) throw new CompanyKeyError(`invalid key scope "${scope}"`)
  return scope
}

const wrappedPath = (scope: string, gen: number) =>
  assertRepoPath(`${LAYOUT.keys}scopes/${scope}/${gen}${ENCRYPTED_SUFFIX}`)

function parseRecipients(text: string): RecipientsFile {
  const raw = parseYaml(text) as Partial<RecipientsFile> | null
  if (!raw || typeof raw.root !== 'string')
    throw new CompanyKeyError(`${RECIPIENTS_PATH} has no root recipient`)
  return { root: raw.root, scopes: raw.scopes ?? {} }
}

/**
 * Reads the key material from the repo (through `read`) and produces file
 * changes for the git engine — it never writes on its own. Without a root
 * identity it can still encrypt (public recipients), never decrypt.
 */
export class KeyRing {
  private unwrapped = new Map<string, string[]>()

  constructor(
    private readonly read: RepoBytesReader,
    private readonly root: RootKey | null,
  ) {}

  async recipients(): Promise<RecipientsFile | null> {
    const bytes = await this.read(RECIPIENTS_PATH)
    return bytes ? parseRecipients(Buffer.from(bytes).toString('utf8')) : null
  }

  private requireRoot(): RootKey {
    if (!this.root)
      throw new CompanyKeyError('the company root key is not available on this server')
    return this.root
  }

  /** Write the root recipient into a fresh repo; refuses a repo that belongs to another root key. */
  async initRoot(): Promise<FileChange[]> {
    const root = this.requireRoot()
    const current = await this.recipients()
    if (current) {
      if (current.root !== root.recipient)
        throw new CompanyKeyError('this repo is encrypted to a different company root key')
      return []
    }
    return [{ path: RECIPIENTS_PATH, content: canonicalYaml({ root: root.recipient, scopes: {} }) }]
  }

  async ensureScope(scope: string): Promise<FileChange[]> {
    assertScope(scope)
    const current = await this.recipients()
    if (!current)
      throw new CompanyKeyError('the repo has no keys yet — initialize the root recipient first')
    if (current.scopes[scope]) return []
    return this.mint(current, scope, 1)
  }

  private async mint(
    current: RecipientsFile,
    scope: string,
    generation: number,
  ): Promise<FileChange[]> {
    const identity = await generateX25519Identity()
    const recipient = await identityToRecipient(identity)
    const next: RecipientsFile = {
      root: current.root,
      scopes: { ...current.scopes, [scope]: { generation, recipient } },
    }
    this.unwrapped.set(scope, [identity, ...(this.unwrapped.get(scope) ?? [])])
    return [
      { path: wrappedPath(scope, generation), content: await ageEncrypt(current.root, identity) },
      { path: RECIPIENTS_PATH, content: canonicalYaml(next) },
    ]
  }

  async encrypt(scope: string, plaintext: Uint8Array | string): Promise<Uint8Array> {
    const entry = (await this.recipients())?.scopes[assertScope(scope)]
    if (!entry) throw new CompanyKeyError(`no key for scope "${scope}"`)
    return ageEncrypt(entry.recipient, plaintext)
  }

  /** Every generation's identity of a scope (newest first) — needs the root key. */
  async scopeIdentities(scope: string): Promise<string[]> {
    const root = this.requireRoot()
    const entry = (await this.recipients())?.scopes[assertScope(scope)]
    if (!entry) throw new CompanyKeyError(`no key for scope "${scope}"`)
    const out: string[] = []
    for (let gen = entry.generation; gen >= 1; gen--) {
      const wrapped = await this.read(wrappedPath(scope, gen))
      if (!wrapped) throw new CompanyKeyError(`wrapped key ${wrappedPath(scope, gen)} is missing`)
      out.push(Buffer.from(await ageDecrypt([root.identity], wrapped)).toString('utf8'))
    }
    this.unwrapped.set(scope, out)
    return out
  }

  async decrypt(scope: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    return ageDecrypt(await this.scopeIdentities(scope), ciphertext)
  }

  /**
   * New generation for `scope`; re-encrypts the given current files (paths →
   * ciphertext at HEAD) to it. Past commits stay readable with the older
   * generations, which remain wrapped in the repo — removing a member stops
   * future access, it cannot un-share history they could already read.
   */
  async rotateScope(scope: string, files: ReadonlyMap<string, Uint8Array>): Promise<FileChange[]> {
    const identities = await this.scopeIdentities(scope)
    const current = (await this.recipients())!
    const generation = current.scopes[scope]!.generation + 1
    const changes = await this.mint(current, scope, generation)
    const recipient = (parseYaml(changes[1]!.content as string) as RecipientsFile).scopes[scope]!
      .recipient
    for (const [path, ciphertext] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
      changes.push({
        path,
        content: await ageEncrypt(recipient, await ageDecrypt(identities, ciphertext)),
      })
    }
    return changes
  }
}
