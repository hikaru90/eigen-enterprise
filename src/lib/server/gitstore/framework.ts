import type { GitAuthor, GitEngine } from './engine'
import type { FileChange } from './keys'

/**
 * The index framework (plan/phase-git-native.md §1.2): files in the company
 * data repo are the truth, Postgres rows are an index derived from them.
 *
 * A surface adopts the framework with one adapter. Writes go through
 * `writeThrough` (write files → update index → commit, batched); reads stay
 * on the index. `rebuildIndex` makes the index equal to the files at HEAD,
 * and `reconcile` (boot, after a pull) rebuilds every surface whose paths
 * changed since its watermark — which also repairs a crash between steps.
 */

export type RepoFile = { path: string; content: string }

/**
 * A migration rewrites one file family from `from` to `from + 1`. It runs
 * during rebuild/reconcile; its file changes are committed (by the server)
 * before the index is built, so data commit X always matches code Y.
 */
export type FormatMigration = {
  from: number
  /** One file at version `from` → its replacement files (content null = delete). */
  migrate(path: string, text: string): FileChange[]
}

export class FormatVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormatVersionError'
  }
}

export type SurfaceAdapter<Entity, Row = Entity> = {
  /** Stable surface id (watermark key, commit batching key), e.g. "groups". */
  readonly surface: string
  /** File family id carried in every file as `format` (e.g. "eigen.group"). */
  readonly format: string
  /** The version this code writes and reads; every file carries `version`. */
  readonly version: number
  /** Read `format` + `version` out of one file (throws when the file has none). */
  formatOf(path: string, text: string): { format: string; version: number }
  /** Registered migrations, one per step (from → from + 1). */
  readonly migrations: readonly FormatMigration[]
  /** Repo path prefixes this surface owns (e.g. ["groups/"]). Nothing else may write under them. */
  readonly paths: readonly string[]
  /** The complete file set that represents one entity (canonical bytes). */
  toFiles(entity: Entity): RepoFile[]
  /**
   * Every file under `paths` → index rows. Invalid files are reported in
   * `problems` (loud, per file) and skipped; they never abort the rebuild.
   */
  fromFiles(
    files: ReadonlyMap<string, string>,
  ): Promise<{ rows: Row[]; problems: string[] }> | { rows: Row[]; problems: string[] }
  /** Make the index hold exactly these rows (idempotent; upsert + delete the rest). */
  replaceIndex(rows: Row[]): Promise<{ problems: string[] }>
}

export type WatermarkStore = {
  get(surface: string): Promise<string | null>
  set(surface: string, commit: string): Promise<void>
}

export function memoryWatermarks(): WatermarkStore & { marks: Map<string, string> } {
  const marks = new Map<string, string>()
  return {
    marks,
    async get(s) {
      return marks.get(s) ?? null
    },
    async set(s, c) {
      marks.set(s, c)
    },
  }
}

export type RebuildReport = { surface: string; commit: string; rows: number; problems: string[] }

export type IndexLogger = (line: string) => void

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdapter = SurfaceAdapter<any, any>

export class IndexFramework {
  private readonly adapters = new Map<string, AnyAdapter>()
  private readonly indexFailed = new Set<string>()

  constructor(
    readonly engine: GitEngine,
    readonly watermarks: WatermarkStore,
    private readonly log: IndexLogger = (l) => console.warn(l),
  ) {
    // Advance a surface's watermark past our own commit when nothing else
    // touched the surface in between; otherwise reconcile catches up.
    engine.onCommit(async (info) => {
      const adapter = this.adapters.get(info.surface)
      if (!adapter || this.indexFailed.has(info.surface)) return
      const mark = await this.watermarks.get(info.surface)
      if (mark === null) return
      if (mark === info.parent || !(await info.touched(mark, info.parent, adapter.paths))) {
        await this.watermarks.set(info.surface, info.commit)
      }
    })
  }

  register(adapter: AnyAdapter): void {
    for (const other of this.adapters.values()) {
      for (const a of adapter.paths)
        for (const b of other.paths) {
          if (a.startsWith(b) || b.startsWith(a))
            throw new Error(
              `surface ${adapter.surface} path ${a} overlaps ${other.surface} path ${b}`,
            )
        }
    }
    this.adapters.set(adapter.surface, adapter)
  }

  surfaces(): string[] {
    return [...this.adapters.keys()].sort()
  }

  private adapter(surface: string): AnyAdapter {
    const a = this.adapters.get(surface)
    if (!a) throw new Error(`no index adapter registered for surface "${surface}"`)
    return a
  }

  /** Index ← files at HEAD for one surface (or all). Pending batches are committed first. */
  async rebuildIndex(surface: string | 'all' = 'all'): Promise<RebuildReport[]> {
    const names = surface === 'all' ? this.surfaces() : [surface]
    const out: RebuildReport[] = []
    for (const name of names) {
      const adapter = this.adapter(name)
      await this.engine.flush(name)
      const commit = await this.engine.head()
      const bytes = await this.engine.readTree(adapter.paths, commit)
      const files = new Map(
        [...bytes].map(([p, b]) => [p, Buffer.from(b).toString('utf8')] as const),
      )
      const migrated = await this.migrate(adapter, files)
      if (migrated) {
        out.push(...(await this.rebuildIndex(name)))
        continue
      }
      const parsed = await adapter.fromFiles(files)
      const written = await adapter.replaceIndex(parsed.rows)
      await this.watermarks.set(name, commit)
      this.indexFailed.delete(name)
      const problems = [...parsed.problems, ...written.problems]
      for (const p of problems) this.log(`[gitstore] ${name}: ${p}`)
      out.push({ surface: name, commit, rows: parsed.rows.length, problems })
    }
    return out
  }

  /**
   * Refuses unknown formats and newer versions loudly (this code cannot read
   * them — install the newer core). Older files run through the registered
   * migrations and are committed as one migration commit. Returns true when
   * a migration commit was made (the caller re-reads HEAD).
   */
  private async migrate(adapter: AnyAdapter, files: Map<string, string>): Promise<boolean> {
    const changes: FileChange[] = []
    const steps = new Set<string>()
    for (const [path, text] of files) {
      let header: { format: string; version: number }
      try {
        header = adapter.formatOf(path, text)
      } catch (err) {
        throw new FormatVersionError(
          `${path}: no readable format/version header (${(err as Error).message})`,
        )
      }
      if (header.format !== adapter.format) {
        throw new FormatVersionError(
          `${path}: unknown format "${header.format}" (surface ${adapter.surface} reads "${adapter.format}")`,
        )
      }
      if (!Number.isInteger(header.version) || header.version < 1)
        throw new FormatVersionError(`${path}: invalid version ${header.version}`)
      if (header.version > adapter.version) {
        throw new FormatVersionError(
          `${path}: ${header.format} v${header.version} is newer than this server understands (v${adapter.version}) — install the core release pinned in system.yaml`,
        )
      }
      let current: FileChange[] = [{ path, content: text }]
      for (let v = header.version; v < adapter.version; v++) {
        const m = adapter.migrations.find((x: FormatMigration) => x.from === v)
        if (!m)
          throw new FormatVersionError(
            `${path}: no migration registered for ${adapter.format} v${v} → v${v + 1}`,
          )
        steps.add(`v${v}→v${v + 1}`)
        const next: FileChange[] = []
        for (const c of current) {
          if (c.content === null) next.push(c)
          else
            next.push(
              ...m.migrate(
                c.path,
                typeof c.content === 'string' ? c.content : Buffer.from(c.content).toString('utf8'),
              ),
            )
        }
        current = next
      }
      if (header.version < adapter.version) {
        const keep = new Set(current.filter((c) => c.content !== null).map((c) => c.path))
        if (!keep.has(path)) changes.push({ path, content: null })
        changes.push(...current.filter((c) => !(c.path === path && c.content === text)))
      }
    }
    if (changes.length === 0) return false
    const staged = await this.engine.stage(adapter.surface, changes, {
      author: this.engine.committerIdentity,
      message: `${adapter.surface}: migrate ${adapter.format} ${[...steps].sort().join(', ')}`,
    })
    await this.engine.flush(adapter.surface)
    await staged.committed
    this.log(
      `[gitstore] ${adapter.surface}: migrated ${changes.length} file change(s) to ${adapter.format} v${adapter.version}`,
    )
    return true
  }

  /**
   * Boot / post-pull repair: commit interrupted writes (boot only), then
   * rebuild every surface whose files changed since its watermark (or that
   * has none, or whose watermark is not in HEAD's history).
   */
  async reconcile(opts: { recover?: boolean } = {}): Promise<RebuildReport[]> {
    if (opts.recover) await this.engine.recoverUncommitted()
    const head = await this.engine.head()
    const out: RebuildReport[] = []
    for (const name of this.surfaces()) {
      const adapter = this.adapter(name)
      const mark = await this.watermarks.get(name)
      if (mark === head) continue
      const stale =
        mark === null ||
        !(await this.engine.isAncestor(mark)) ||
        (await this.engine.changedSince(mark, adapter.paths)).length > 0
      if (stale) out.push(...(await this.rebuildIndex(name)))
      else await this.watermarks.set(name, head)
    }
    return out
  }

  /**
   * File-first write: stage the files (working tree + git index), update the
   * Postgres index, then the commit lands (immediately or with the surface's
   * debounce) — the watermark only moves past a commit whose index update
   * already happened. A crash after the file write but before the commit is
   * repaired by `reconcile({ recover: true })` at boot.
   */
  async writeThrough(input: {
    surface: string
    changes: FileChange[]
    author: GitAuthor
    message: string
    index: () => Promise<void>
  }): Promise<{ committed: Promise<string | null> }> {
    const adapter = this.adapter(input.surface)
    for (const c of input.changes) {
      if (!adapter.paths.some((p) => c.path.startsWith(p))) {
        throw new Error(
          `surface ${input.surface} may not write ${c.path} (owns ${adapter.paths.join(', ')})`,
        )
      }
    }
    const staged = await this.engine.stage(input.surface, input.changes, {
      author: input.author,
      message: input.message,
      hold: true,
    })
    try {
      await input.index()
    } catch (err) {
      this.indexFailed.add(input.surface) // watermark stays behind → reconcile rebuilds
      throw err
    } finally {
      // the files are the truth: even when the index update failed, the write
      // is committed and reconcile brings the index back in line
      await this.engine.release(input.surface)
    }
    return staged
  }
}
