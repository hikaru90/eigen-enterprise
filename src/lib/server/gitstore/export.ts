import type { GitAuthor } from './engine'
import type { IndexFramework, SurfaceAdapter } from './framework'
import type { FileChange } from './keys'

/**
 * One-time export of the current database into the data repo — the
 * migration path for installs that predate git-native. Per surface: every
 * entity in the DB → its files → ONE commit; the watermark then points at it.
 * Refuses a surface that already has files in the repo (never overwrites).
 */
export type ExportSource<E> = { adapter: SurfaceAdapter<E, unknown>; loadAll(): Promise<E[]> }

export type ExportReport = {
  surface: string
  entities: number
  files: number
  commit: string | null
}

export async function exportDbToRepo(
  framework: IndexFramework,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sources: ExportSource<any>[],
  author: GitAuthor,
): Promise<ExportReport[]> {
  const out: ExportReport[] = []
  for (const src of sources) {
    const { adapter } = src
    for (const prefix of adapter.paths) {
      if ((await framework.engine.listWorking(prefix)).length > 0) {
        throw new Error(
          `export refused: the repo already has files under ${prefix} — the ${adapter.surface} surface was exported before`,
        )
      }
    }
    const entities = await src.loadAll()
    const changes: FileChange[] = []
    const seen = new Set<string>()
    for (const e of entities) {
      for (const f of adapter.toFiles(e)) {
        if (seen.has(f.path))
          throw new Error(`export: two ${adapter.surface} entities map to ${f.path}`)
        seen.add(f.path)
        changes.push(f)
      }
    }
    let commit: string | null = null
    if (changes.length) {
      const staged = await framework.engine.stage(adapter.surface, changes, {
        author,
        message: `${adapter.surface}: export ${entities.length} from the database`,
      })
      await framework.engine.flush(adapter.surface)
      commit = await staged.committed
    }
    await framework.watermarks.set(adapter.surface, await framework.engine.head())
    out.push({ surface: adapter.surface, entities: entities.length, files: changes.length, commit })
  }
  return out
}
