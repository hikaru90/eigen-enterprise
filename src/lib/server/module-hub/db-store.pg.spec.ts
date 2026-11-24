import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MODULE_HUB_PATHS } from '$lib/module-hub/contract'
import type { AppDatabase } from '$lib/server/db/context'
import { TEST_ONLY_MODULE_HUB_ORIGIN, TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8 } from '../../../../contracts/fixtures/module-hub-test-key'
import { dbHubStore } from '../../../../modules/contribute/hub/db-store'
import { authenticate, register, revokeInstall, type HubDeps } from '../../../../modules/contribute/hub/service'
import { registerBody, signed, testInstall } from '../../../../modules/contribute/hub/test-fixtures'
import { memoryBundleStorage } from '../../../../modules/module-hub/bundles'
import { lockCatalog } from '../../../../modules/module-hub/checks'
import { dbModuleHubStore } from '../../../../modules/module-hub/db-store'
import { getHubModule, listHubModules, publishModule, reportModuleRun, type ModuleHubDeps } from '../../../../modules/module-hub/service'
import { bundleOf, COMMIT_B, helloFiles, publishBody, withFile } from '../../../../modules/module-hub/test-fixtures'

/**
 * The module hub over real Postgres (the test DB, :5433), with the contribute
 * hub's own install store. Needs DATABASE_URL with migrations applied (0180);
 * skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('module hub store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const installs: string[] = []
  let clock = Date.now()

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (installs.length > 0) {
      await sql`delete from hub_module_runs where install_id in ${sql(installs)}`
      await sql`delete from hub_modules where install_id in ${sql(installs)}`
      await sql`delete from hub_module_versions where install_id in ${sql(installs)}`
      await sql`delete from hub_installs where install_id in ${sql(installs)}`
      await sql`delete from hub_request_counts where install_id in ${sql(installs)}`
    }
    await sql.end()
  })

  function deps(): ModuleHubDeps & { hub: HubDeps } {
    const hub: HubDeps = { store: dbHubStore(db), now: () => clock }
    return {
      hub,
      authenticate: (req) => authenticate(hub, req),
      now: () => clock,
      store: dbModuleHubStore(db),
      bundles: memoryBundleStorage(),
      signingKey: () => TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
      origin: () => TEST_ONLY_MODULE_HUB_ORIGIN,
      catalog: lockCatalog(),
      enqueueSummary: async () => {},
    }
  }

  async function registeredInstall(d: { hub: HubDeps }) {
    const i = testInstall()
    installs.push(i.installId)
    await register(d.hub, registerBody(i))
    return i
  }
  const req = (i: ReturnType<typeof testInstall>, method: string, path: string, body: string) => signed(i, method, path, body, (clock += 1))

  it('publishes, repeats, refuses another bundle for the commit, lists, reads and records runs', async () => {
    const d = deps()
    const a = await registeredInstall(d)
    // A unique module per run so the bundle sha never collides with an earlier run's rows.
    const id = `hub${randomUUID().slice(0, 8)}`
    const files = withFile(helloFiles(), 'module.yaml', new TextDecoder().decode(helloFiles().find((f) => f.path === 'module.yaml')!.content).replace('id: hello', `id: ${id}`))
    const v1 = bundleOf(files)
    const first = await publishModule(d, req(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(v1)))
    expect(first.status).toBe(201)
    const again = await publishModule(d, req(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(v1)))
    expect(again).toEqual({ status: 200, body: first.body })

    const v2 = bundleOf(withFile(files, 'README.md', `${randomUUID()}\n`))
    expect((await publishModule(d, req(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(v2)))).status).toBe(409)
    expect((await publishModule(d, req(a, 'POST', MODULE_HUB_PATHS.publish, publishBody(v2, { commit: COMMIT_B })))).status).toBe(201)

    const run = JSON.stringify({ v: 1, bundle_sha256: v2.sha256, state: 'running' })
    expect((await reportModuleRun(d, req(a, 'PUT', MODULE_HUB_PATHS.run(id), run), id)).status).toBe(200)
    const stopped = JSON.stringify({ v: 1, bundle_sha256: v2.sha256, state: 'stopped' })
    await reportModuleRun(d, req(a, 'PUT', MODULE_HUB_PATHS.run(id), stopped), id)

    const listed = await listHubModules(d, { query: id })
    expect(listed.modules).toEqual([expect.objectContaining({ installId: a.installId, moduleId: id, versions: 2, latestBundleSha256: v2.sha256, description: expect.any(String) })])
    const detail = await getHubModule(d, a.installId, id)
    expect(detail.versions.map((v) => v.bundleSha256)).toEqual([v2.sha256, v1.sha256])
    expect(detail.runs).toEqual([expect.objectContaining({ installId: a.installId, state: 'stopped', version: '0.1.0' })])

    await d.store.setSummary(v2.sha256, { does: 'd', touches: 't', sendsOut: 's' }, new Date(clock))
    expect((await d.store.getVersion(v2.sha256))?.summary).toEqual({ does: 'd', touches: 't', sendsOut: 's' })

    await revokeInstall(d.hub, a.installId)
    expect((await listHubModules(d, { query: id })).modules).toEqual([])
    expect(await d.store.getVersion(v1.sha256)).not.toBeNull()
  })
})
