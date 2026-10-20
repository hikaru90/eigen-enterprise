import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkDeployKey, createDeployKey, deleteDeployKey, GITHUB_KNOWN_HOSTS, sshRepoUrl } from './deploy-keys.ts'
import { PATHS } from './paths.ts'
import { SecretStore } from './secret-store.ts'
import { fetchSource } from './sources.ts'
import type { RunResult, System } from './system.ts'

const PRIVATE = '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfakekeymaterial\n-----END OPENSSH PRIVATE KEY-----\n'
const PUBLIC = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKE ee-deploy'

type FileEntry = { content: string; mode?: number }
type Call = { cmd: string; args: string[]; env?: Record<string, string>; filesAtCall: Map<string, FileEntry> }

/** In-memory box: ssh-keygen writes a key pair, git answers ls-remote/fetch from a script. */
class FakeSystem implements System {
  files = new Map<string, FileEntry>()
  calls: Call[] = []
  lsRemote: RunResult = {
    code: 0,
    stdout: `${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/heads/feature/x\n`,
    stderr: '',
  }

  async readFile(p: string) {
    return this.files.get(p)?.content ?? null
  }
  async writeFile(p: string, c: string, mode?: number) {
    this.files.set(p, { content: c, mode })
  }
  async mkdirp() {}
  async exists(p: string) {
    return [...this.files.keys()].some((k) => k === p || k.startsWith(p + '/'))
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k)
  }
  async sha256File(): Promise<string> {
    throw new Error('unused')
  }
  async run(cmd: string, args: string[], opts?: { env?: Record<string, string> }): Promise<RunResult> {
    this.calls.push({ cmd, args, env: opts?.env, filesAtCall: new Map(this.files) })
    if (cmd === 'ssh-keygen') {
      const f = args[args.indexOf('-f') + 1]!
      this.files.set(f, { content: PRIVATE, mode: 0o600 })
      this.files.set(`${f}.pub`, { content: `${PUBLIC}\n`, mode: 0o644 })
      return { code: 0, stdout: '', stderr: '' }
    }
    if (cmd === 'git' && args.includes('ls-remote')) return this.lsRemote
    if (cmd === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
  async httpOk() {
    return true
  }
  async caddyLoad() {}
  async sleep() {}
  now() {
    return new Date('2026-10-20T00:00:00Z')
  }
}

async function box() {
  const sys = new FakeSystem()
  sys.files.set(PATHS.masterKey, { content: randomBytes(32).toString('base64') })
  const store = await SecretStore.open(sys)
  return { sys, store }
}

describe('deploy keys', () => {
  it('generates an ed25519 key pair with ssh-keygen and returns only the public key', async () => {
    const { sys, store } = await box()
    const out = await createDeployKey(sys, store, { repo: 'kindred/app' })
    expect(out).toEqual({ keyId: expect.stringMatching(/^dk_[a-f0-9]{24}$/), publicKey: PUBLIC })
    const gen = sys.calls.find((c) => c.cmd === 'ssh-keygen')!
    expect(gen.args).toEqual(expect.arrayContaining(['-t', 'ed25519', '-N', '', '-q']))
    // The temp key files are gone afterwards.
    expect([...sys.files.keys()].filter((k) => k.startsWith(PATHS.sshTmp))).toEqual([])
  })

  it('stores the private key sealed: the store file never holds it in plaintext', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    const blob = sys.files.get(PATHS.secrets)!
    expect(blob.mode).toBe(0o600)
    expect(blob.content).not.toContain('fakekeymaterial')
    expect(blob.content.startsWith('ee-secrets-v1.')).toBe(true)
    const reopened = await SecretStore.open(sys)
    const saved = JSON.parse(reopened.all()['_deploy_keys']![keyId]!)
    expect(saved).toEqual({ repo: 'kindred/app', publicKey: PUBLIC, privateKey: PRIVATE })
  })

  it('rejects a repo that is not owner/repo', async () => {
    const { sys, store } = await box()
    await expect(createDeployKey(sys, store, { repo: 'kindred/app;rm -rf /' })).rejects.toThrow(/owner\/repo/)
  })

  it('check runs a read-only git ls-remote over ssh with the key file and pinned GitHub host keys', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    const out = await checkDeployKey(sys, store, keyId, { repo: 'kindred/app' })
    expect(out).toEqual({ ok: true, branches: ['feature/x', 'main'] })

    const call = sys.calls.find((c) => c.cmd === 'git' && c.args.includes('ls-remote'))!
    expect(call.args).toEqual(['ls-remote', '--heads', 'git@github.com:kindred/app.git'])
    const ssh = call.env!.GIT_SSH_COMMAND!
    expect(ssh).toContain('-o StrictHostKeyChecking=yes')
    expect(ssh).toContain('-o IdentitiesOnly=yes')
    expect(ssh).toContain('-o BatchMode=yes')
    expect(ssh).not.toContain('accept-new')
    expect(ssh).not.toContain('StrictHostKeyChecking=no')
    const keyPath = /-i (\S+)/.exec(ssh)![1]!
    const khPath = /UserKnownHostsFile=(\S+)/.exec(ssh)![1]!
    // At the moment ssh ran, the key file existed with mode 0600 and known_hosts held GitHub's keys.
    expect(call.filesAtCall.get(keyPath)).toEqual({ content: PRIVATE, mode: 0o600 })
    expect(call.filesAtCall.get(khPath)!.content).toBe(GITHUB_KNOWN_HOSTS)
    expect(GITHUB_KNOWN_HOSTS).toContain(
      'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
    )
    // …and both are deleted after use.
    expect(sys.files.has(keyPath)).toBe(false)
    expect(sys.files.has(khPath)).toBe(false)
  })

  it('check reports a refusal as a code, keeping the ssh output only as detail for the log', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    sys.lsRemote = {
      code: 128,
      stdout: '',
      stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    }
    const out = await checkDeployKey(sys, store, keyId, { repo: 'kindred/app' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toBe('not_accepted')
    expect(out.detail).toContain('Permission denied')
    expect([...sys.files.keys()].filter((k) => k.startsWith(PATHS.sshTmp))).toEqual([])
  })

  it('check refuses a key that belongs to another repo', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    await expect(checkDeployKey(sys, store, keyId, { repo: 'kindred/other' })).rejects.toThrow(/belongs to kindred\/app/)
  })

  it('delete removes the key from the sealed store; deleting an unknown key fails loud', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    await deleteDeployKey(store, keyId)
    expect((await SecretStore.open(sys)).all()['_deploy_keys']?.[keyId]).toBeUndefined()
    await expect(deleteDeployKey(store, keyId)).rejects.toThrow(/no deploy key/)
  })

  it('fetchSource with a deploy key fetches over ssh with the key and pinned hosts, then cleans up', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    const rev = await fetchSource(sys, { name: 'app', url: sshRepoUrl('kindred/app'), ref: 'main', deployKeyId: keyId }, store)
    expect(rev).toBe('c'.repeat(40))
    const call = sys.calls.find((c) => c.cmd === 'git' && c.args.includes('fetch'))!
    expect(call.args).toContain('git@github.com:kindred/app.git')
    expect(call.env!.GIT_SSH_COMMAND).toContain('StrictHostKeyChecking=yes')
    const keyPath = /-i (\S+)/.exec(call.env!.GIT_SSH_COMMAND!)![1]!
    expect(call.filesAtCall.get(keyPath)?.mode).toBe(0o600)
    expect(sys.files.has(keyPath)).toBe(false)
  })

  it('fetchSource refuses a deploy key for a different repo than the url', async () => {
    const { sys, store } = await box()
    const { keyId } = await createDeployKey(sys, store, { repo: 'kindred/app' })
    await expect(
      fetchSource(sys, { name: 'x', url: sshRepoUrl('kindred/other'), ref: 'main', deployKeyId: keyId }, store),
    ).rejects.toThrow(/belongs to kindred\/app/)
  })
})
