import type { GitHubCredentials } from './api'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'
import type { AppDatabase } from '$lib/server/db/context'
import { githubAppLinks, githubConnection } from '$lib/server/db/github.schema'
import { env } from '$lib/server/env/private-env'

/**
 * Persistence for the company's GitHub App. Credentials are sealed with a key
 * derived from the instance TENANT_MASTER_KEY (AAD-bound to this purpose) and
 * unsealed only in memory, per use.
 */

export type GitHubConnection = {
  appId: number
  appSlug: string
  clientId: string
  htmlUrl: string
  installationId: number | null
}

export type AppLink = { workload: string; repoFullName: string; ref: string; autoDeploy: boolean }

export type GitHubStore = {
  connection(): Promise<GitHubConnection | null>
  credentials(): Promise<GitHubCredentials>
  saveConnection(c: Omit<GitHubConnection, 'installationId'>, creds: GitHubCredentials): Promise<void>
  setInstallation(installationId: number): Promise<void>
  links(): Promise<AppLink[]>
  link(workload: string): Promise<AppLink | null>
  saveLink(l: AppLink): Promise<void>
  removeLink(workload: string): Promise<void>
}

const AAD = 'github-app-credentials'

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

export function sealKey(masterKey: string): Buffer {
  if (!masterKey.trim()) throw new Error('TENANT_MASTER_KEY is required to seal GitHub credentials')
  return createHash('sha256').update(`${AAD}:${masterKey.trim()}`, 'utf8').digest()
}

export class DbGitHubStore implements GitHubStore {
  constructor(
    private readonly db: DbHandle,
    private readonly key: () => Buffer,
  ) {}

  async connection(): Promise<GitHubConnection | null> {
    const [row] = await (await resolveDb(this.db)).select().from(githubConnection).limit(1)
    if (!row) return null
    return { appId: row.appId, appSlug: row.appSlug, clientId: row.clientId, htmlUrl: row.htmlUrl, installationId: row.installationId }
  }

  async credentials(): Promise<GitHubCredentials> {
    const [row] = await (await resolveDb(this.db)).select({ sealed: githubConnection.sealedCredentials }).from(githubConnection).limit(1)
    if (!row) throw new Error('GitHub is not connected — connect it in Settings → Hosting')
    return JSON.parse(decryptEnvelope(row.sealed, this.key(), AAD)) as GitHubCredentials
  }

  async saveConnection(c: Omit<GitHubConnection, 'installationId'>, creds: GitHubCredentials): Promise<void> {
    const sealedCredentials = encryptEnvelope(JSON.stringify(creds), this.key(), AAD)
    const values = { id: 'github', ...c, sealedCredentials, installationId: null, updatedAt: new Date() }
    await (await resolveDb(this.db))
      .insert(githubConnection)
      .values(values)
      .onConflictDoUpdate({ target: githubConnection.id, set: values })
  }

  async setInstallation(installationId: number): Promise<void> {
    const out = await (await resolveDb(this.db))
      .update(githubConnection)
      .set({ installationId, updatedAt: new Date() })
      .where(eq(githubConnection.id, 'github'))
      .returning({ id: githubConnection.id })
    if (out.length === 0) throw new Error('GitHub installation callback without a connected app')
  }

  async links(): Promise<AppLink[]> {
    const rows = await (await resolveDb(this.db)).select().from(githubAppLinks)
    return rows.map((r) => ({ workload: r.workload, repoFullName: r.repoFullName, ref: r.ref, autoDeploy: r.autoDeploy }))
  }

  async link(workload: string): Promise<AppLink | null> {
    return (await this.links()).find((l) => l.workload === workload) ?? null
  }

  async saveLink(l: AppLink): Promise<void> {
    const values = { ...l, updatedAt: new Date() }
    await (await resolveDb(this.db)).insert(githubAppLinks).values(values).onConflictDoUpdate({ target: githubAppLinks.workload, set: values })
  }

  async removeLink(workload: string): Promise<void> {
    await (await resolveDb(this.db)).delete(githubAppLinks).where(eq(githubAppLinks.workload, workload))
  }
}

export function defaultGitHubStore(): GitHubStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  }
  return new DbGitHubStore(db, () => {
    const masterKey = env.TENANT_MASTER_KEY
    if (!masterKey) throw new Error('TENANT_MASTER_KEY is required to seal GitHub credentials')
    return sealKey(masterKey)
  })
}

/** In-memory store for tests. */
export class InMemoryGitHubStore implements GitHubStore {
  conn: GitHubConnection | null = null
  creds: GitHubCredentials | null = null
  private linkMap = new Map<string, AppLink>()
  async connection() {
    return this.conn
  }
  async credentials() {
    if (!this.creds) throw new Error('GitHub is not connected — connect it in Settings → Hosting')
    return this.creds
  }
  async saveConnection(c: Omit<GitHubConnection, 'installationId'>, creds: GitHubCredentials) {
    this.conn = { ...c, installationId: null }
    this.creds = creds
  }
  async setInstallation(id: number) {
    if (!this.conn) throw new Error('GitHub installation callback without a connected app')
    this.conn = { ...this.conn, installationId: id }
  }
  async links() {
    return [...this.linkMap.values()]
  }
  async link(w: string) {
    return this.linkMap.get(w) ?? null
  }
  async saveLink(l: AppLink) {
    this.linkMap.set(l.workload, l)
  }
  async removeLink(w: string) {
    this.linkMap.delete(w)
  }
}
