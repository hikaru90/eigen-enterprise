import type { RepoAuthKind } from '../github/repos-store'
import type { ContractForm } from './contract'
import { asc, eq } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { websiteServices } from '$lib/server/db/website-services.schema'

/**
 * Services (migration 0095): a connected repo + branch deployed as an ee app.
 * Env values live in ee's sealed store; `contract` (migration 0101) is the
 * saved build settings of the last healthy deploy — the config "Redeploy"
 * replays and the owner-side record when ee no longer holds the workload's
 * contract. The runtime source of a form-built app stays ee's company repo.
 */

export type ServiceKind = 'web' | 'backend'
export type ServiceState = 'new' | 'deploying' | 'healthy' | 'failed'

export type Service = {
  name: string
  kind: ServiceKind
  repoFullName: string
  branch: string
  repoId: number | null
  authKind: RepoAuthKind
  /** Web apps: the host they're served at. Back-end services: null (no public route). */
  host: string | null
  /** Push-to-deploy; only github_app repos get webhooks. */
  autoDeploy: boolean
  state: ServiceState
  lastRev: string | null
  /** Plain sentence for the owner, never raw build output. */
  lastError: string | null
  lastDeployedAt: Date | null
  lastDeployedBy: string | null
  /** The mail-only API key sealed into the app as EE_API_KEY; null = email off. */
  mailKeyId: string | null
  /** The saved build settings of the last healthy deploy; null = the repo's ee.json is the config. */
  contract: ContractForm | null
  createdBy: string
  createdAt: Date
}

export type NewService = Pick<
  Service,
  | 'name'
  | 'kind'
  | 'repoFullName'
  | 'branch'
  | 'repoId'
  | 'authKind'
  | 'host'
  | 'autoDeploy'
  | 'createdBy'
>

export type DeployOutcome = {
  state: 'healthy' | 'failed'
  rev: string
  error: string | null
  by: string
  at: Date
  /** The saved build settings to keep after this outcome: the form that went healthy, or the previous ones on a failure. */
  contract: ContractForm | null
}

export type ServiceStore = {
  list(): Promise<Service[]>
  get(name: string): Promise<Service | null>
  /** Creates the row, or updates the source fields of an existing one. */
  upsert(s: NewService): Promise<Service>
  markDeploying(name: string): Promise<void>
  recordDeploy(name: string, o: DeployOutcome): Promise<void>
  /** Remember (or forget, with null) the mail key sealed into the app. */
  setMailKey(name: string, keyId: string | null): Promise<void>
  remove(name: string): Promise<void>
}

function validate(s: NewService): void {
  if (s.kind === 'web' && !s.host) throw new Error(`the web app ${s.name} needs a host`)
  if (s.autoDeploy && (s.authKind !== 'github_app' || s.repoId === null)) {
    throw new Error(
      `push-to-deploy needs a repo connected through the GitHub App (${s.repoFullName} is ${s.authKind})`,
    )
  }
}

export class InMemoryServiceStore implements ServiceStore {
  rows = new Map<string, Service>()
  async list() {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  async get(name: string) {
    return this.rows.get(name) ?? null
  }
  async upsert(s: NewService) {
    validate(s)
    const existing = this.rows.get(s.name)
    const row: Service = existing
      ? { ...existing, ...s, createdBy: existing.createdBy }
        : {
            ...s,
            state: 'new',
            lastRev: null,
            lastError: null,
            lastDeployedAt: null,
            lastDeployedBy: null,
            mailKeyId: null,
            contract: null,
            createdAt: new Date(),
          }
    this.rows.set(s.name, row)
    return row
  }
  async markDeploying(name: string) {
    const r = this.rows.get(name)
    if (!r) throw new Error(`no service ${name}`)
    this.rows.set(name, { ...r, state: 'deploying' })
  }
  async recordDeploy(name: string, o: DeployOutcome) {
    const r = this.rows.get(name)
    if (!r) throw new Error(`no service ${name}`)
    this.rows.set(name, {
      ...r,
      state: o.state,
      lastRev: o.rev,
      lastError: o.error,
      lastDeployedAt: o.at,
      lastDeployedBy: o.by,
      contract: o.contract,
    })
  }
  async setMailKey(name: string, keyId: string | null) {
    const r = this.rows.get(name)
    if (!r) throw new Error(`no service ${name}`)
    this.rows.set(name, { ...r, mailKeyId: keyId })
  }
  async remove(name: string) {
    this.rows.delete(name)
  }
}

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

type Row = typeof websiteServices.$inferSelect

const fromRow = (r: Row): Service => ({
  name: r.name,
  kind: r.kind,
  repoFullName: r.repoFullName,
  branch: r.branch,
  repoId: r.repoId,
  authKind: r.authKind,
  host: r.host,
  autoDeploy: r.autoDeploy,
  state: r.state,
  lastRev: r.lastRev,
  lastError: r.lastError,
  lastDeployedAt: r.lastDeployedAt,
  lastDeployedBy: r.lastDeployedBy,
  mailKeyId: r.mailKeyId,
  contract: (r.contract ?? null) as ContractForm | null,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
})

export class DbServiceStore implements ServiceStore {
  constructor(private readonly db: DbHandle) {}

  async list() {
    const rows = await (
      await resolveDb(this.db)
    )
      .select()
      .from(websiteServices)
      .orderBy(asc(websiteServices.name))
    return rows.map(fromRow)
  }
  async get(name: string) {
    const [row] = await (
      await resolveDb(this.db)
    )
      .select()
      .from(websiteServices)
      .where(eq(websiteServices.name, name))
    return row ? fromRow(row) : null
  }
  async upsert(s: NewService) {
    validate(s)
    const { createdBy: _createdBy, ...source } = s
    const [row] = await (
      await resolveDb(this.db)
    )
      .insert(websiteServices)
      .values(s)
      .onConflictDoUpdate({
        target: websiteServices.name,
        set: { ...source, updatedAt: new Date() },
      })
      .returning()
    return fromRow(row)
  }
  async markDeploying(name: string) {
    const out = await (
      await resolveDb(this.db)
    )
      .update(websiteServices)
      .set({ state: 'deploying', updatedAt: new Date() })
      .where(eq(websiteServices.name, name))
      .returning({ name: websiteServices.name })
    if (out.length === 0) throw new Error(`no service ${name}`)
  }
  async recordDeploy(name: string, o: DeployOutcome) {
    const out = await (
      await resolveDb(this.db)
    )
      .update(websiteServices)
      .set({
        state: o.state,
        lastRev: o.rev,
        lastError: o.error,
        lastDeployedAt: o.at,
        lastDeployedBy: o.by,
        contract: o.contract,
        updatedAt: new Date(),
      })
      .where(eq(websiteServices.name, name))
      .returning({ name: websiteServices.name })
    if (out.length === 0) throw new Error(`no service ${name}`)
  }
  async setMailKey(name: string, keyId: string | null) {
    const out = await (
      await resolveDb(this.db)
    )
      .update(websiteServices)
      .set({ mailKeyId: keyId, updatedAt: new Date() })
      .where(eq(websiteServices.name, name))
      .returning({ name: websiteServices.name })
    if (out.length === 0) throw new Error(`no service ${name}`)
  }
  async remove(name: string) {
    await (await resolveDb(this.db)).delete(websiteServices).where(eq(websiteServices.name, name))
  }
}

export function defaultServiceStore(): ServiceStore {
  return new DbServiceStore(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
  })
}
