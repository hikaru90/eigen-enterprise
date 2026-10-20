import { randomBytes } from 'node:crypto'
import { PATHS } from './paths.ts'
import type { SecretStore } from './secret-store.ts'
import { mustRun, type RunResult, type System } from './system.ts'

/**
 * Read-only GitHub deploy keys (plan/github-connect.md). ee owns the private
 * key: generated here with ssh-keygen, kept only inside the sealed secret
 * store (scope `_deploy_keys`, AES-GCM under the host key), and written to a
 * 0600 temp file for exactly one git call, then deleted. The OS and the
 * browser only ever see the public key and the key id.
 *
 * Host keys are pinned: ssh runs with StrictHostKeyChecking=yes against
 * GitHub's published keys (https://api.github.com/meta, checked 2026-10-20),
 * never accept-new and never off.
 */

const SCOPE = '_deploy_keys'
export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/
export const KEY_ID = /^dk_[a-f0-9]{24}$/

export const GITHUB_KNOWN_HOSTS = [
  'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
].join('\n') + '\n'

type StoredKey = { repo: string; publicKey: string; privateKey: string }
type KeyStore = Pick<SecretStore, 'all' | 'set' | 'delete'>

export const sshRepoUrl = (repo: string) => `git@github.com:${repo}.git`

function assertRepo(repo: string): void {
  if (!REPO.test(repo)) throw new Error(`deploy keys need a GitHub owner/repo, got ${JSON.stringify(repo)}`)
}

export function loadDeployKey(store: Pick<SecretStore, 'all'>, keyId: string, repo: string): StoredKey {
  if (!KEY_ID.test(keyId)) throw new Error(`not a deploy key id: ${JSON.stringify(keyId)}`)
  const raw = store.all()[SCOPE]?.[keyId]
  if (raw === undefined) throw new Error(`no deploy key ${keyId}`)
  const key = JSON.parse(raw) as StoredKey
  if (key.repo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`deploy key ${keyId} belongs to ${key.repo}, not ${repo}`)
  }
  return key
}

/** Generate a fresh ed25519 pair for one repo; returns only the public half. */
export async function createDeployKey(sys: System, store: KeyStore, i: { repo: string }): Promise<{ keyId: string; publicKey: string }> {
  assertRepo(i.repo)
  const keyId = `dk_${randomBytes(12).toString('hex')}`
  const dir = `${PATHS.sshTmp}/keygen-${keyId}`
  const file = `${dir}/id_ed25519`
  await sys.mkdirp(dir, 0o700)
  try {
    await mustRun(sys, 'ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `ee-deploy-${i.repo}`, '-q', '-f', file])
    const privateKey = await sys.readFile(file)
    const publicKey = (await sys.readFile(`${file}.pub`))?.trim()
    if (!privateKey || !publicKey) throw new Error('ssh-keygen wrote no key pair')
    const stored: StoredKey = { repo: i.repo, publicKey, privateKey }
    await store.set(SCOPE, keyId, JSON.stringify(stored))
    return { keyId, publicKey }
  } finally {
    await sys.remove(dir)
  }
}

export async function deleteDeployKey(store: KeyStore, keyId: string): Promise<void> {
  if (!KEY_ID.test(keyId)) throw new Error(`not a deploy key id: ${JSON.stringify(keyId)}`)
  if (!(await store.delete(SCOPE, keyId))) throw new Error(`no deploy key ${keyId}`)
}

/**
 * Run one git command with the key: the key goes to a 0600 file in a fresh
 * 0700 dir with the pinned known_hosts, GIT_SSH_COMMAND points ssh at both,
 * and the dir is removed afterwards whatever happens.
 */
export async function withDeployKey(
  sys: System,
  key: StoredKey,
  git: (env: Record<string, string>) => Promise<RunResult>,
): Promise<RunResult> {
  const dir = `${PATHS.sshTmp}/use-${randomBytes(8).toString('hex')}`
  await sys.mkdirp(dir, 0o700)
  try {
    await sys.writeFile(`${dir}/key`, key.privateKey, 0o600)
    await sys.writeFile(`${dir}/known_hosts`, GITHUB_KNOWN_HOSTS, 0o600)
    const ssh = [
      'ssh',
      `-i ${dir}/key`,
      '-F /dev/null',
      '-o IdentitiesOnly=yes',
      '-o BatchMode=yes',
      '-o StrictHostKeyChecking=yes',
      `-o UserKnownHostsFile=${dir}/known_hosts`,
      '-o GlobalKnownHostsFile=/dev/null',
    ].join(' ')
    return await git({ GIT_SSH_COMMAND: ssh, GIT_TERMINAL_PROMPT: '0' })
  } finally {
    await sys.remove(dir)
  }
}

export type CheckResult = { ok: true; branches: string[] } | { ok: false; error: 'not_accepted'; detail: string }

/** Read-only: `git ls-remote --heads` over ssh. Branch names come from the structured ref list. */
export async function checkDeployKey(sys: System, store: KeyStore, keyId: string, i: { repo: string }): Promise<CheckResult> {
  assertRepo(i.repo)
  const key = loadDeployKey(store, keyId, i.repo)
  const r = await withDeployKey(sys, key, (env) =>
    sys.run('git', ['ls-remote', '--heads', sshRepoUrl(i.repo)], { env, timeoutMs: 60_000 }),
  )
  if (r.code !== 0) return { ok: false, error: 'not_accepted', detail: (r.stderr || r.stdout).trim().slice(-1000) }
  const branches = r.stdout
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((ref): ref is string => ref?.startsWith('refs/heads/') ?? false)
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
  return { ok: true, branches }
}
