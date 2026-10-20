import { and, asc, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { githubConnectedRepos } from '$lib/server/db/github.schema'

/**
 * Connected GitHub repositories: what a later deploy needs (GitHub's repo id,
 * branch, and how to read it: public, the App installation id, or ee's deploy
 * key id). Never a token, never key material.
 */

/** public: no auth. github_app: the App installation. deploy_key: a read-only key ee holds. */
export type RepoAuthKind = 'public' | 'github_app' | 'deploy_key'

export type ConnectedRepo = {
  /** GitHub's numeric id; null for deploy-key repos (never read through the API). */
  repoId: number | null
  fullName: string
  branch: string
  htmlUrl: string
  cloneUrl: string
  visibility: 'public' | 'private'
  authKind: RepoAuthKind
  /** Set for github_app repos (the App installation that can read it). */
  installationId: number | null
  /** Set for deploy_key repos: ee's key id (the key itself stays sealed in ee). */
  deployKeyId: string | null
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
  const shape = `${repo.fullName} (${repo.authKind})`
  if (repo.authKind === 'public') {
    if (
      repo.visibility !== 'public' ||
      repo.repoId === null ||
      repo.installationId !== null ||
      repo.deployKeyId !== null
    )
      throw new Error(`a public repository ${shape} has a repo id and no installation or key`)
  } else if (repo.authKind === 'github_app') {
    if (repo.installationId === null)
      throw new Error(`a private repository ${shape} needs the App installation id`)
    if (repo.visibility !== 'private' || repo.repoId === null || repo.deployKeyId !== null)
      throw new Error(`an App repository ${shape} is private, has a repo id and no deploy key`)
  } else {
    if (repo.deployKeyId === null)
      throw new Error(`a deploy-key repository ${shape} needs the key id`)
    if (repo.visibility !== 'private' || repo.installationId !== null)
      throw new Error(`a deploy-key repository ${shape} is private and has no installation`)
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
    const clash = (r: ConnectedRepo) =>
      r.branch === repo.branch &&
      ((repo.repoId !== null && r.repoId === repo.repoId) || sameName(r.fullName, repo.fullName))
    if (this.rows.some(clash)) {
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
  authKind: r.authKind,
  installationId: r.installationId,
  deployKeyId: r.deployKeyId,
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
          eq(sql`lower(${githubConnectedRepos.fullName})`, match.fullName.toLowerCase()),
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
