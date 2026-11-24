import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createBundle, forbiddenBundlePath, type BundleFile } from '../../contracts/module-bundle'
import { MODULE_MANIFEST_FILE, parseModuleManifestYaml, type ModuleManifestV1 } from '../../contracts/module-manifest'
import { KernelError } from '$lib/kernel/errors'
import { spawnGit, type GitAuthor, type GitRunner } from '$lib/server/gitstore/engine'

/**
 * The module repo (plan/phase-upgrades-u2.md §3, D1): one git working tree
 * per box at `$EE_STATE_DIR/module-repo/`, separate from the company data
 * repo, with one folder `<id>/` per module. Only the kernel writes it (the
 * `modules.*` tools), and every commit is authored by the acting person. It
 * has no remote: the hub holds every published version.
 */

export const MODULE_REPO_DIR = 'module-repo'

const COMMIT = /^[0-9a-f]{40}$/
const MAX_FILE_BYTES = 1024 * 1024

export type TreeEntry = { path: string; size: number }

export class ModuleRepo {
  private queue: Promise<unknown> = Promise.resolve()
  private opened = false

  constructor(
    readonly dir: string,
    private readonly run: GitRunner = spawnGit,
  ) {}

  /** One repo operation at a time (writes and commits race otherwise). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async git(args: string[], env?: Record<string, string>): Promise<string> {
    const r = await this.run(args, { cwd: this.dir, ...(env ? { env } : {}) })
    if (r.code !== 0) throw new Error(`module repo: git ${args[0]} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`)
    return r.stdout
  }

  /** Creates the repo (with an initial commit) or opens it. */
  async open(): Promise<void> {
    if (this.opened) return
    await this.exclusive(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      const exists = await stat(join(this.dir, '.git')).then(
        () => true,
        () => false,
      )
      if (!exists) {
        await this.git(['init', '-q', '-b', 'main'])
        await writeFile(
          join(this.dir, 'README.md'),
          '# Modules of this company\n\nOne folder per module. Module code is open source (Apache-2.0) and shared with eigenEnterprise.\n',
        )
        await this.git(['add', 'README.md'])
        await this.git(['commit', '-q', '-m', 'module repo initialized'], committerEnv(KERNEL_AUTHOR))
      }
    })
    this.opened = true
  }

  async exists(id: string): Promise<boolean> {
    await this.open()
    return stat(join(this.dir, id)).then(
      (s) => s.isDirectory(),
      () => false,
    )
  }

  /** Writes a file inside `<id>/` (the working tree; commit to make it a version). */
  async writeFile(id: string, path: string, content: string): Promise<void> {
    const rel = checkedPath(path)
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) {
      throw new KernelError('invalid_input', `${path} is over ${MAX_FILE_BYTES} bytes`)
    }
    await this.open()
    await this.exclusive(async () => {
      const abs = join(this.dir, id, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    })
  }

  async deleteFile(id: string, path: string): Promise<void> {
    const rel = checkedPath(path)
    await this.open()
    await this.exclusive(async () => {
      const abs = join(this.dir, id, rel)
      const there = await stat(abs).then(
        (s) => s.isFile(),
        () => false,
      )
      if (!there) throw new KernelError('invalid_input', `${id}/${rel} does not exist`)
      await rm(abs)
    })
  }

  /** Commits everything under `<id>/`; returns the commit (unchanged: the last commit of the folder). */
  async commit(id: string, message: string, author: GitAuthor): Promise<{ commit: string; changed: boolean }> {
    await this.open()
    return this.exclusive(async () => {
      await this.git(['add', '-A', '--', id])
      const staged = await this.run(['diff', '--cached', '--quiet', '--', id], { cwd: this.dir })
      if (staged.code === 0) {
        const last = (await this.git(['log', '-1', '--format=%H', '--', id])).trim()
        if (!last) throw new KernelError('invalid_input', `${id}/ has nothing to commit`)
        return { commit: last, changed: false }
      }
      await this.git(['commit', '-q', '-m', message, '--', id], committerEnv(author))
      return { commit: (await this.git(['rev-parse', 'HEAD'])).trim(), changed: true }
    })
  }

  /** The last commit that touched `<id>/`, or null. */
  async lastCommit(id: string): Promise<string | null> {
    await this.open()
    const out = (await this.exclusive(() => this.git(['log', '-1', '--format=%H', '--', id]))).trim()
    return out || null
  }

  /** The files of `<id>/` at `commit` (paths relative to the module folder). */
  async files(id: string, commit: string): Promise<BundleFile[]> {
    await this.requireCommit(id, commit)
    return this.exclusive(async () => {
      const ls = await this.git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', `${id}/`])
      const out: BundleFile[] = []
      for (const line of ls.split('\0').filter(Boolean)) {
        const [meta, path] = line.split('\t') as [string, string]
        const [mode, type, sha] = meta.split(' ') as [string, string, string]
        if (type !== 'blob' || mode === '120000') {
          throw new KernelError('invalid_input', `${path} is not a regular file; a module holds regular files only`)
        }
        const content = Buffer.from(await this.git(['cat-file', 'blob', sha]), 'utf8')
        out.push({ path: path.slice(id.length + 1), content, ...(mode === '100755' ? { executable: true } : {}) })
      }
      return out
    })
  }

  async commitTime(commit: string): Promise<Date> {
    const out = await this.exclusive(() => this.git(['show', '-s', '--format=%ct', commit]))
    return new Date(Number(out.trim()) * 1000)
  }

  /** The module's manifest at `commit`, checked: it parses and names this module. */
  async manifest(id: string, commit: string): Promise<ModuleManifestV1> {
    const files = await this.files(id, commit)
    const yaml = files.find((f) => f.path === MODULE_MANIFEST_FILE)
    if (!yaml) throw new KernelError('invalid_input', `${id}@${commit.slice(0, 12)} has no ${MODULE_MANIFEST_FILE}`)
    const manifest = parseModuleManifestYaml(Buffer.from(yaml.content).toString('utf8'))
    if (manifest.id !== id) {
      throw new KernelError('invalid_input', `${id}/${MODULE_MANIFEST_FILE} names the module "${manifest.id}"`)
    }
    return manifest
  }

  /** The deterministic bundle of `<id>/` at `commit` (§6.1). */
  async bundle(id: string, commit: string): Promise<{ bytes: Buffer; sha256: string }> {
    const files = await this.files(id, commit)
    return createBundle(files, await this.commitTime(commit))
  }

  /** The tree of `<id>/`: at a commit, or the working tree when commit is null. */
  async tree(id: string, commit: string | null): Promise<TreeEntry[]> {
    if (commit !== null) {
      return (await this.files(id, commit)).map((f) => ({ path: f.path, size: f.content.byteLength }))
    }
    await this.open()
    const out = await this.exclusive(() =>
      this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `${id}/`]),
    )
    const entries: TreeEntry[] = []
    for (const p of [...new Set(out.split('\0').filter(Boolean))].sort()) {
      const s = await stat(join(this.dir, p)).catch(() => null)
      if (s?.isFile()) entries.push({ path: p.slice(id.length + 1), size: s.size })
    }
    return entries
  }

  /** One file's text: at a commit, or in the working tree when commit is null. */
  async read(id: string, path: string, commit: string | null): Promise<string> {
    const rel = checkedPath(path, { forRead: true })
    if (commit !== null) {
      const file = (await this.files(id, commit)).find((f) => f.path === rel)
      if (!file) throw new KernelError('invalid_input', `${id}@${commit.slice(0, 12)} has no ${rel}`)
      return Buffer.from(file.content).toString('utf8')
    }
    await this.open()
    try {
      return await readFile(join(this.dir, id, rel), 'utf8')
    } catch {
      throw new KernelError('invalid_input', `${id}/${rel} does not exist`)
    }
  }

  private async requireCommit(id: string, commit: string): Promise<void> {
    if (!COMMIT.test(commit)) throw new KernelError('invalid_input', `"${commit}" is not a 40-hex commit`)
    await this.open()
    const r = await this.exclusive(() =>
      this.run(['cat-file', '-e', `${commit}^{commit}`], { cwd: this.dir }),
    )
    if (r.code !== 0) throw new KernelError('invalid_input', `the module repo has no commit ${commit}`)
    const touched = await this.exclusive(() => this.git(['ls-tree', '--name-only', commit, '--', id]))
    if (!touched.trim()) throw new KernelError('invalid_input', `${id}/ does not exist at ${commit.slice(0, 12)}`)
  }
}

export const KERNEL_AUTHOR: GitAuthor = { name: 'eigenEnterprise', email: 'os@eigen.local' }

function committerEnv(author: GitAuthor): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: KERNEL_AUTHOR.name,
    GIT_COMMITTER_EMAIL: KERNEL_AUTHOR.email,
  }
}

/**
 * A path inside a module folder: relative, no empty, "." or ".." segments,
 * and never a file §6.1 keeps out of bundles (node_modules, .git, .env*,
 * keys) — the kernel refuses to commit those in the first place.
 */
export function checkedPath(path: string, opts: { forRead?: boolean } = {}): string {
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new KernelError('invalid_input', `"${path}" is not a relative path inside the module folder`)
  }
  if (!opts.forRead) {
    const forbidden = forbiddenBundlePath(path)
    if (forbidden) throw new KernelError('invalid_input', `${path}: ${forbidden}`)
  }
  return path
}
