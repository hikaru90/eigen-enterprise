import { and, asc, eq } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { githubConnectedRepos } from '$lib/server/db/github.schema'

/**
 * Connected GitHub repositories: what a later deploy needs (GitHub's repo id,
 * branch, installation id for private repos). Never a token.
 */

export type ConnectedRepo = {
  repoId: number
  fullName: string
  branch: string
  htmlUrl: string
  cloneUrl: string
  visibility: 'public' | 'private'
  /** Set for private repos (the App installation that can read it); null for public ones. */
  installationId: number | null
  connectedBy: string
  createdAt: Date
}

export type NewConnectedRepo = Omit<ConnectedRepo, 'createdAt'>

export type ConnectedRepoStore = {
  list(): Promise<ConnectedRepo[]>
  /** Fails loud when the repo+branch is already connected. */
  add(repo: NewConnectedRepo): Promise<ConnectedRepo>
  /** Returns the removed row; null when nothing matched. */
  remove(fullName: string, branch: string): Promise<ConnectedRepo | null>
}

export class RepoAlreadyConnectedError extends Error {
  constructor(
    readonly fullName: string,
    readonly branch: string,
  ) {
    super(`${fullName} (${branch}) is already connected`)
    this.name = 'RepoAlreadyConnectedError'
  }
}

function validate(repo: NewConnectedRepo): void {
  if (repo.visibility === 'private' && repo.installationId === null) {
    throw new Error(`a private repository (${repo.fullName}) needs the App installation id`)
  }
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export class InMemoryConnectedRepoStore implements ConnectedRepoStore {
  rows: ConnectedRepo[] = []
  async list() {
    return [...this.rows].sort(
      (a, b) => a.fullName.localeCompare(b.fullName) || a.branch.localeCompare(b.branch),
    )
  }
  async add(repo: NewConnectedRepo) {
    validate(repo)
    if (this.rows.some((r) => r.repoId === repo.repoId && r.branch === repo.branch)) {
      throw new RepoAlreadyConnectedError(repo.fullName, repo.branch)
    }
    const row = { ...repo, createdAt: new Date() }
    this.rows.push(row)
    return row
  }
  async remove(fullName: string, branch: string) {
    const i = this.rows.findIndex((r) => sameName(r.fullName, fullName) && r.branch === branch)
    if (i < 0) return null
    return this.rows.splice(i, 1)[0]
  }
}

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

type Row = typeof githubConnectedRepos.$inferSelect

const fromRow = (r: Row): ConnectedRepo => ({
  repoId: r.repoId,
  fullName: r.fullName,
  branch: r.branch,
  htmlUrl: r.htmlUrl,
  cloneUrl: r.cloneUrl,
  visibility: r.visibility,
  installationId: r.installationId,
  connectedBy: r.connectedBy,
  createdAt: r.createdAt,
})

export class DbConnectedRepoStore implements ConnectedRepoStore {
  constructor(private readonly db: DbHandle) {}

  async list() {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(githubConnectedRepos)
      .orderBy(asc(githubConnectedRepos.fullName), asc(githubConnectedRepos.branch))
    return rows.map(fromRow)
  }

  async add(repo: NewConnectedRepo) {
    validate(repo)
    const out = await (
      await resolveDb(this.db)
    )
      .insert(githubConnectedRepos)
      .values(repo)
      .onConflictDoNothing()
      .returning()
    if (out.length === 0) throw new RepoAlreadyConnectedError(repo.fullName, repo.branch)
    return fromRow(out[0])
  }

  async remove(fullName: string, branch: string) {
    const db = await resolveDb(this.db)
    const match = (await this.list()).find(
      (r) => sameName(r.fullName, fullName) && r.branch === branch,
    )
    if (!match) return null
    await db
      .delete(githubConnectedRepos)
      .where(
        and(
          eq(githubConnectedRepos.repoId, match.repoId),
          eq(githubConnectedRepos.branch, match.branch),
        ),
      )
    return match
  }
}

export function defaultConnectedRepoStore(): ConnectedRepoStore {
  return new DbConnectedRepoStore(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  })
}
