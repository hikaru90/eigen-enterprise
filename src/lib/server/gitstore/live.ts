import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { env } from '$lib/server/env/private-env'
import type { GroupStore } from '$lib/server/members/groups'
import { dbGroupStore } from '$lib/server/members/groups-db-store'
import { dbGroupIndex, dbWatermarks } from './db'
import { GitEngine, resolveCompanyDataDir, type GitAuthor } from './engine'
import { exportDbToRepo, type ExportReport } from './export'
import { IndexFramework, type RebuildReport } from './framework'
import { gitGroupStore, groupsAdapter } from './surfaces/groups'

/**
 * The live company data repo for this process (the os workload is the one
 * writer). Opened lazily once: open/create the repo, register adapters, boot
 * reconcile (commit interrupted writes, rebuild stale surfaces).
 */

/** users → their name + email; anything else (an agent principal) → an agent identity. */
export async function liveAuthor(actorId: string): Promise<GitAuthor> {
  const [u] = await authDb
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, actorId))
    .limit(1)
  if (u) return { name: u.name || u.email, email: u.email }
  return {
    name: `agent ${actorId}`,
    email: `${actorId.replace(/[^A-Za-z0-9._-]/g, '-')}@agents.eigen.local`,
  }
}

type Live = { framework: IndexFramework; groups: GroupStore; boot: RebuildReport[] }

let live: Promise<Live> | null = null

export function buildFramework(dir: string): IndexFramework {
  const engine = new GitEngine({ dir })
  const framework = new IndexFramework(engine, dbWatermarks)
  framework.register(groupsAdapter(dbGroupIndex))
  return framework
}

async function open(): Promise<Live> {
  const framework = buildFramework(resolveCompanyDataDir(env))
  await framework.engine.open()
  await framework.engine.recoverUncommitted()
  // An install that predates git-native: the DB has the data, the repo has
  // nothing and there is no watermark → export once instead of rebuilding an
  // empty index (which would wipe the data).
  if (
    (await dbWatermarks.get('groups')) === null &&
    (await framework.engine.listWorking('groups/')).length === 0
  ) {
    await exportLiveDb(framework, framework.engine.committerIdentity)
  }
  const boot = await framework.reconcile()
  const groups = gitGroupStore({
    framework,
    index: dbGroupIndex,
    reads: dbGroupStore,
    author: liveAuthor,
  })
  return { framework, groups, boot }
}

export function companyData(): Promise<Live> {
  if (!live) {
    live = open().catch((err) => {
      live = null
      throw err
    })
  }
  return live
}

/** Migration path: export the DB's groups into a repo that has none yet. */
export async function exportLiveDb(
  framework: IndexFramework,
  author: GitAuthor,
): Promise<ExportReport[]> {
  return exportDbToRepo(
    framework,
    [{ adapter: groupsAdapter(dbGroupIndex), loadAll: () => dbGroupIndex.all() }],
    author,
  )
}
