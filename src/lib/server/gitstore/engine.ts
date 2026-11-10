import type { FileChange } from './keys'
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertRepoPath } from './layout'

/**
 * The git engine for the company data repo (plan/phase-git-native.md §4).
 *
 * One writer: this process owns the working copy. Every git invocation is
 * serialized through one queue, so the index/working tree is never shared
 * between two operations. Writes are staged per surface and committed in
 * batches (a per-surface debounce; 0 = commit at once) with the acting member
 * as author and the server as committer. Pull is fetch → fast-forward only;
 * anything else is a loud, persisted conflict state — nothing is overwritten.
 *
 * Git CLI via spawn (git is on every box, LFS comes in G2, and ee's desired-
 * state repo already works this way); credentials are passed through
 * environment config (GIT_CONFIG_*), never argv, never stored.
 */

export type GitAuthor = { name: string; email: string }

export type GitResult = { code: number; stdout: string; stderr: string }
export type GitRunner = (
  args: readonly string[],
  opts: { cwd: string; env?: Record<string, string>; input?: string },
) => Promise<GitResult>

export const spawnGit: GitRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (b: Buffer) => out.push(b))
    child.stderr.on('data', (b: Buffer) => err.push(b))
    child.on('error', reject)
    child.on('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    )
    // git may exit without reading stdin (most commands never do); the write then fails with
    // EPIPE, which unhandled is an uncaught exception that kills the process. The command's
    // outcome is its exit code + stderr (resolved above), so EPIPE is not a result; anything
    // else is.
    child.stdin.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code !== 'EPIPE') reject(e)
    })
    child.stdin.end(opts.input ?? '')
  })

export class GitEngineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitEngineError'
  }
}

export type ConflictState = { local: string; remote: string; detectedAt: string; reason: string }

/** Thrown when the remote and the local history diverged; also persisted until resolved. */
export class GitConflictError extends GitEngineError {
  constructor(readonly state: ConflictState) {
    super(
      `company data repo diverged from the remote (local ${state.local.slice(0, 12)}, remote ${state.remote.slice(0, 12)}): ${state.reason}. Nothing was overwritten — a person must merge and push, then clear the conflict.`,
    )
    this.name = 'GitConflictError'
  }
}

export type RemoteCredentials = { username: string; password: string }
export type Remote = { url: string; credentials?: () => Promise<RemoteCredentials | null> }

export type CommitInfo = {
  surface: string
  commit: string
  parent: string
  paths: string[]
  /** Whether anything under `prefixes` differs between two commits (usable inside a listener). */
  touched(from: string, to: string, prefixes: readonly string[]): Promise<boolean>
}
export type ChangedPath = { status: 'A' | 'M' | 'D'; path: string }

type Batch = {
  author: GitAuthor
  messages: string[]
  paths: Set<string>
  timer: ReturnType<typeof setTimeout> | null
  waiters: Array<{ resolve: (c: string | null) => void; reject: (e: unknown) => void }>
}

export type GitEngineOptions = {
  dir: string
  committer?: GitAuthor
  /** Per-surface commit debounce in ms (default 0 = commit at once). */
  debounceMs?: Record<string, number>
  run?: GitRunner
}

/** `COMPANY_DATA_DIR`, else `$EE_STATE_DIR/company-data`, else refuse. */
export function resolveCompanyDataDir(env: Record<string, string | undefined>): string {
  const explicit = env.COMPANY_DATA_DIR?.trim()
  if (explicit) return explicit
  const substrate = env.EE_STATE_DIR?.trim()
  if (substrate) return join(substrate, 'company-data')
  throw new Error(
    'The company data repo is not configured: set COMPANY_DATA_DIR to a writable directory, or run under the ee substrate which injects EE_STATE_DIR (the repo then lives at $EE_STATE_DIR/company-data). Refusing to guess — company data must never land in a default location.',
  )
}

const DEFAULT_COMMITTER: GitAuthor = { name: 'eigenEnterprise', email: 'os@eigen.local' }

function authorString(a: GitAuthor): string {
  const clean = (s: string) => s.replace(/[<>\n\r]/g, '').trim()
  const name = clean(a.name)
  const email = clean(a.email)
  if (!name || !email) throw new GitEngineError('a commit author needs a name and an email')
  return `${name} <${email}>`
}

export class GitEngine {
  readonly dir: string
  private readonly run: GitRunner
  private readonly committer: GitAuthor
  private readonly debounce: Record<string, number>
  private queue: Promise<unknown> = Promise.resolve()
  private readonly batches = new Map<string, Batch>()
  private readonly commitListeners: Array<(info: CommitInfo) => Promise<void> | void> = []
  private pushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: GitEngineOptions) {
    this.dir = opts.dir
    this.run = opts.run ?? spawnGit
    this.committer = opts.committer ?? DEFAULT_COMMITTER
    this.debounce = opts.debounceMs ?? {}
  }

  /** Serialize every repo operation. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async git(
    args: string[],
    opts: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {},
  ): Promise<GitResult> {
    const r = await this.run(args, { cwd: this.dir, env: opts.env, input: opts.input })
    if (r.code !== 0 && !opts.allowFail) {
      throw new GitEngineError(
        `git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`,
      )
    }
    return r
  }

  private committerEnv(author?: GitAuthor): Record<string, string> {
    const a = author ?? this.committer
    return {
      GIT_AUTHOR_NAME: a.name,
      GIT_AUTHOR_EMAIL: a.email,
      GIT_COMMITTER_NAME: this.committer.name,
      GIT_COMMITTER_EMAIL: this.committer.email,
    }
  }

  get committerIdentity(): GitAuthor {
    return this.committer
  }

  onCommit(listener: (info: CommitInfo) => Promise<void> | void): void {
    this.commitListeners.push(listener)
  }

  /** Create the repo (with an initial commit, so HEAD always exists) or verify it. */
  async open(): Promise<void> {
    await this.exclusive(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const exists = await stat(join(this.dir, '.git')).then(
        () => true,
        () => false,
      )
      if (!exists) {
        await this.git(['init', '-q', '-b', 'main'])
        await writeFile(join(this.dir, '.gitattributes'), '*.age binary\n')
        await this.git(['add', '.gitattributes'])
        await this.git(['commit', '-q', '-m', 'company data repo initialized'], {
          env: this.committerEnv(),
        })
        return
      }
      const top = (await this.git(['rev-parse', '--show-toplevel'])).stdout.trim()
      if (top !== (await realpath(this.dir)))
        throw new GitEngineError(`${this.dir} is not the root of a git repo`)
      await this.git(['rev-parse', '--verify', 'HEAD'])
    })
  }

  async head(): Promise<string> {
    return this.exclusive(async () => (await this.git(['rev-parse', 'HEAD'])).stdout.trim())
  }

  /** Bytes in the working tree (includes staged-but-uncommitted writes). */
  async readWorking(path: string): Promise<Uint8Array | null> {
    assertRepoPath(path)
    try {
      return await readFile(join(this.dir, path))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  async listWorking(prefix: string): Promise<string[]> {
    return this.exclusive(async () => {
      const r = await this.git([
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        prefix,
      ])
      const files = r.stdout.split('\0').filter(Boolean)
      const present: string[] = []
      for (const f of files)
        if (
          await stat(join(this.dir, f)).then(
            () => true,
            () => false,
          )
        )
          present.push(f)
      return [...new Set(present)].sort()
    })
  }

  /** Every file under the prefixes at `ref`, path → bytes. */
  async readTree(prefixes: readonly string[], ref = 'HEAD'): Promise<Map<string, Uint8Array>> {
    return this.exclusive(async () => {
      const out = new Map<string, Uint8Array>()
      if (prefixes.length === 0) return out
      const ls = await this.git(['ls-tree', '-r', '-z', '--full-tree', ref, '--', ...prefixes])
      for (const line of ls.stdout.split('\0').filter(Boolean)) {
        const [meta, path] = line.split('\t') as [string, string]
        const sha = meta.split(' ')[2]!
        const blob = await this.runBytes(['cat-file', 'blob', sha])
        out.set(path, blob)
      }
      return out
    })
  }

  private runBytes(args: string[]): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.dir, env: { ...process.env, LC_ALL: 'C' } })
      const out: Buffer[] = []
      child.stdout.on('data', (b: Buffer) => out.push(b))
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0
          ? resolve(Buffer.concat(out))
          : reject(new GitEngineError(`git ${args.join(' ')} failed`)),
      )
    })
  }

  /**
   * Write files into the working tree and stage them under `surface`. The
   * returned promise settles when the batch that carries them is committed
   * (null when the batch had no effective change). With a debounce of 0 the
   * commit happens before this resolves; with `hold` nothing is scheduled
   * until `release(surface)` (write-through: index between file and commit).
   */
  async stage(
    surface: string,
    changes: readonly FileChange[],
    meta: { author: GitAuthor; message: string; hold?: boolean },
  ): Promise<{ committed: Promise<string | null> }> {
    if (changes.length === 0) throw new GitEngineError('nothing to stage')
    authorString(meta.author)
    const committed = await this.exclusive(async () => {
      let batch = this.batches.get(surface)
      if (batch && authorString(batch.author) !== authorString(meta.author)) {
        await this.commitBatch(surface)
        batch = undefined
      }
      for (const c of changes) {
        const abs = join(this.dir, assertRepoPath(c.path))
        if (c.content === null) {
          await rm(abs, { force: true })
          await this.git(['rm', '-q', '--cached', '--ignore-unmatch', '--', c.path])
        } else {
          await mkdir(dirname(abs), { recursive: true })
          const tmp = `${abs}.tmp-${process.pid}`
          await writeFile(tmp, c.content)
          await rename(tmp, abs)
          await this.git(['add', '--', c.path])
        }
      }
      if (!batch) {
        batch = { author: meta.author, messages: [], paths: new Set(), timer: null, waiters: [] }
        this.batches.set(surface, batch)
      }
      batch.messages.push(meta.message)
      for (const c of changes) batch.paths.add(c.path)
      const target = batch
      const promise = new Promise<string | null>((resolve, reject) =>
        target.waiters.push({ resolve, reject }),
      )
      promise.catch(() => undefined) // a failed immediate commit already rejects stage() itself
      if (!meta.hold) await this.schedule(surface)
      // boxed: returning the bare promise would make the queue wait for the commit
      return { promise }
    })
    return { committed: committed.promise }
  }

  /** Inside the queue: commit now (debounce 0) or arm the surface's debounce timer. */
  private async schedule(surface: string): Promise<void> {
    const batch = this.batches.get(surface)
    if (!batch) return
    const wait = this.debounce[surface] ?? 0
    if (wait <= 0) await this.commitBatch(surface)
    else if (!batch.timer)
      batch.timer = setTimeout(() => void this.flush(surface).catch(() => undefined), wait)
  }

  /** Let a held batch (`stage(..., { hold: true })`) commit on its normal schedule. */
  async release(surface: string): Promise<void> {
    await this.exclusive(() => this.schedule(surface))
  }

  /** Commit pending batches now (one surface, or all). */
  async flush(surface?: string): Promise<void> {
    await this.exclusive(async () => {
      for (const s of surface ? [surface] : [...this.batches.keys()]) await this.commitBatch(s)
    })
  }

  /** Inside the queue. */
  private async commitBatch(surface: string): Promise<void> {
    const batch = this.batches.get(surface)
    if (!batch) return
    this.batches.delete(surface)
    if (batch.timer) clearTimeout(batch.timer)
    try {
      const parent = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
      const paths = [...batch.paths].sort()
      const subject =
        batch.messages.length === 1
          ? batch.messages[0]!
          : `${surface}: ${batch.messages.length} changes`
      const body =
        batch.messages.length === 1 ? '' : `\n\n${batch.messages.map((m) => `- ${m}`).join('\n')}`
      const diff = await this.git(['diff', '--cached', '--quiet', 'HEAD', '--', ...paths], {
        allowFail: true,
      })
      if (diff.code === 0) {
        for (const w of batch.waiters) w.resolve(null)
        return
      }
      await this.git(['commit', '-q', '--no-verify', '-F', '-', '--', ...paths], {
        env: this.committerEnv(batch.author),
        input: `${subject}${body}\n`,
      })
      const commit = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
      const touched = async (from: string, to: string, prefixes: readonly string[]) =>
        (await this.git(['diff', '--quiet', from, to, '--', ...prefixes], { allowFail: true }))
          .code !== 0
      // listeners run inside the queue: they must not call engine methods (use `touched`)
      for (const l of this.commitListeners) await l({ surface, commit, parent, paths, touched })
      for (const w of batch.waiters) w.resolve(commit)
    } catch (err) {
      for (const w of batch.waiters) w.reject(err)
      throw err
    }
  }

  /**
   * Boot repair: anything left in the working tree by a crash between "write
   * file" and "commit" is committed now as a recovery commit. Returns the
   * commit (or null when the tree was clean).
   */
  async recoverUncommitted(): Promise<string | null> {
    return this.exclusive(async () => {
      if (this.batches.size > 0)
        throw new GitEngineError('recoverUncommitted must run before any write (boot only)')
      const status = await this.git(['status', '--porcelain', '-z', '--untracked-files=all'])
      if (status.stdout.length === 0) return null
      await this.git(['add', '-A'])
      await this.git(
        ['commit', '-q', '--no-verify', '-m', 'recover writes interrupted before commit'],
        { env: this.committerEnv() },
      )
      return (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
    })
  }

  /** Files changed between `since` (a commit, or null = the empty tree) and HEAD. */
  async changedSince(
    since: string | null,
    prefixes: readonly string[] = [],
  ): Promise<ChangedPath[]> {
    return this.exclusive(async () => {
      const base =
        since ??
        (await this.git(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).stdout.trim()
      const r = await this.git([
        'diff',
        '--name-status',
        '--no-renames',
        '-z',
        base,
        'HEAD',
        '--',
        ...prefixes,
      ])
      const parts = r.stdout.split('\0').filter(Boolean)
      const out: ChangedPath[] = []
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const s = parts[i]!.charAt(0)
        out.push({ status: s === 'A' ? 'A' : s === 'D' ? 'D' : 'M', path: parts[i + 1]! })
      }
      return out
    })
  }

  async isAncestor(maybeAncestor: string, of = 'HEAD'): Promise<boolean> {
    return this.exclusive(async () => {
      const r = await this.git(['merge-base', '--is-ancestor', maybeAncestor, of], {
        allowFail: true,
      })
      if (r.code === 0) return true
      if (r.code === 1) return false
      return false // unknown commit (history rewritten / foreign repo)
    })
  }

  // -------------------------------------------------------------------------
  // Remote
  // -------------------------------------------------------------------------

  private get conflictFile(): string {
    return join(this.dir, '.git', 'eigen-conflict.json')
  }

  async conflict(): Promise<ConflictState | null> {
    try {
      return JSON.parse(await readFile(this.conflictFile, 'utf8')) as ConflictState
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  }

  /** A person merged by hand: clear the state only once HEAD contains the remote commit. */
  async clearConflict(): Promise<void> {
    const state = await this.conflict()
    if (!state) return
    if (!(await this.isAncestor(state.remote))) {
      throw new GitEngineError(
        `HEAD does not contain the remote commit ${state.remote.slice(0, 12)} yet — merge it first`,
      )
    }
    await rm(this.conflictFile, { force: true })
  }

  private async remoteEnv(remote: Remote): Promise<Record<string, string>> {
    const creds = remote.credentials ? await remote.credentials() : null
    if (!creds) return {}
    const basic = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    }
  }

  private async recordConflict(local: string, remote: string, reason: string): Promise<never> {
    const state: ConflictState = { local, remote, detectedAt: new Date().toISOString(), reason }
    await writeFile(this.conflictFile, `${JSON.stringify(state, null, 2)}\n`)
    throw new GitConflictError(state)
  }

  /**
   * fetch → fast-forward only. Returns the paths that changed (empty when
   * nothing new). A diverged history records the conflict and throws.
   */
  async pull(remote: Remote): Promise<{ from: string; to: string; changed: ChangedPath[] }> {
    await this.flush()
    const env = await this.remoteEnv(remote)
    const result = await this.exclusive(async () => {
      const existing = await this.conflict()
      if (existing) throw new GitConflictError(existing)
      const from = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
      const fetched = await this.git(['fetch', '-q', '--no-tags', remote.url, 'refs/heads/main'], {
        env,
        allowFail: true,
      })
      if (fetched.code !== 0) {
        if (/couldn't find remote ref/i.test(fetched.stderr)) return { from, to: from, ff: false }
        throw new GitEngineError(`git fetch failed: ${fetched.stderr.trim()}`)
      }
      const remoteHead = (await this.git(['rev-parse', 'FETCH_HEAD'])).stdout.trim()
      if (remoteHead === from) return { from, to: from, ff: false }
      const ahead = await this.git(['merge-base', '--is-ancestor', remoteHead, from], {
        allowFail: true,
      })
      if (ahead.code === 0) return { from, to: from, ff: false }
      const ffable = await this.git(['merge-base', '--is-ancestor', from, remoteHead], {
        allowFail: true,
      })
      if (ffable.code !== 0) return this.recordConflict(from, remoteHead, 'non-fast-forward pull')
      await this.git(['merge', '-q', '--ff-only', remoteHead])
      return { from, to: remoteHead, ff: true }
    })
    if (!result.ff) return { from: result.from, to: result.to, changed: [] }
    return { from: result.from, to: result.to, changed: await this.changedSince(result.from) }
  }

  /** Push HEAD to the remote's main. A rejected (non-fast-forward) push is a loud conflict. */
  async push(remote: Remote): Promise<string> {
    await this.flush()
    const env = await this.remoteEnv(remote)
    return this.exclusive(async () => {
      const existing = await this.conflict()
      if (existing) throw new GitConflictError(existing)
      const head = (await this.git(['rev-parse', 'HEAD'])).stdout.trim()
      const r = await this.git(['push', '-q', '--porcelain', remote.url, 'HEAD:refs/heads/main'], {
        env,
        allowFail: true,
      })
      if (r.code !== 0) {
        if (/\[rejected\]|non-fast-forward|fetch first/i.test(r.stdout + r.stderr)) {
          const fetched = await this.git(
            ['fetch', '-q', '--no-tags', remote.url, 'refs/heads/main'],
            { env, allowFail: true },
          )
          const remoteHead =
            fetched.code === 0
              ? (await this.git(['rev-parse', 'FETCH_HEAD'])).stdout.trim()
              : 'unknown'
          return this.recordConflict(
            head,
            remoteHead,
            'push rejected: the remote has commits this server does not',
          )
        }
        throw new GitEngineError(`git push failed: ${(r.stderr || r.stdout).trim()}`)
      }
      return head
    })
  }

  /** Debounced push (fire-and-forget; failures go to `onError`). */
  schedulePush(remote: Remote, delayMs: number, onError: (err: unknown) => void): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.push(remote).catch(onError)
    }, delayMs)
  }

  /** Stop timers (tests / shutdown) after committing what is pending. */
  async close(): Promise<void> {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    await this.flush()
  }
}
