/**
 * Operator CLI for the company data repo (plan/phase-git-native.md G0):
 *
 *   npm run company-data -- rebuild-index [surface|all]   index ← repo files at HEAD
 *   npm run company-data -- reconcile                     boot repair (recover + rebuild stale)
 *   npm run company-data -- export                        one-time DB → repo (migration path)
 *   npm run company-data -- status                        HEAD, watermarks, conflict, system.yaml
 *
 * Runs as the os workload (same env: DATABASE_URL, EE_STATE_DIR or
 * COMPANY_DATA_DIR). ee's `ee rebuild-index` verb invokes this entry point.
 */
import { dbWatermarks } from '$lib/server/gitstore/db'
import { resolveCompanyDataDir } from '$lib/server/gitstore/engine'
import { buildFramework, exportLiveDb } from '$lib/server/gitstore/live'
import { readSystemPin } from '$lib/server/gitstore/system'

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv
  const framework = buildFramework(resolveCompanyDataDir(process.env))
  await framework.engine.open()
  switch (cmd) {
    case 'rebuild-index':
      console.info(JSON.stringify(await framework.rebuildIndex(arg ?? 'all'), null, 2))
      return 0
    case 'reconcile':
      console.info(JSON.stringify(await framework.reconcile({ recover: true }), null, 2))
      return 0
    case 'export':
      console.info(
        JSON.stringify(await exportLiveDb(framework, framework.engine.committerIdentity), null, 2),
      )
      return 0
    case 'status': {
      const head = await framework.engine.head()
      const marks = Object.fromEntries(
        await Promise.all(
          framework.surfaces().map(async (s) => [s, await dbWatermarks.get(s)] as const),
        ),
      )
      const system = await readSystemPin(
        async (p) => (await framework.engine.readTree([p], head)).get(p) ?? null,
      )
      console.info(
        JSON.stringify(
          {
            dir: framework.engine.dir,
            head,
            watermarks: marks,
            conflict: await framework.engine.conflict(),
            system,
          },
          null,
          2,
        ),
      )
      return 0
    }
    default:
      console.error('usage: company-data rebuild-index [surface|all] | reconcile | export | status')
      return 1
  }
}

process.exit(await main(process.argv.slice(2).filter((a) => a !== '--')))
