import { join } from 'node:path'
import { PATHS } from '../paths.ts'
import { mustRun, type System } from '../system.ts'
import type { S3Client } from './s3.ts'
import { fetchSnapshot, runToFile, type BackupSources, type Manifest } from './snapshot.ts'
import { BACKUP_SERVICE, BACKUP_TIMER, defaultSchedule, renderBackupService, renderBackupTimer } from './timer.ts'

/** The ee runtime (same pinned Node as ee.service). */
export const EE_NODE = `${PATHS.runtimes}/node-22/bin/node`

/** The company DB is the os workload's own database (reconcile.ts ensureDatabase: role = db = "os"). */
export const COMPANY_DB = 'os'

/** What a snapshot takes on a real box. */
export function productionSources(): BackupSources {
  return {
    dbDump: ['runuser', '-u', 'postgres', '--', 'pg_dump', '--format=custom', '--no-password', COMPANY_DB],
    driveDir: join(PATHS.osState, 'drive'),
    agentDb: join(PATHS.osState, 'agent', 'agent.sqlite'),
    // The desired state, the sealed secret store (incl. deploy keys, the backup
    // config) and the host key that unseals it: together they are ee.
    eeState: [PATHS.company, PATHS.secrets, PATHS.masterKey],
    tmpDir: PATHS.backupTmp,
  }
}

/** Install/refresh the nightly timer for a schedule (bootstrap, upgrade, and every config save). */
export async function writeBackupTimer(sys: System, s: { hour: number; minute: number } | null): Promise<void> {
  const schedule = s ?? defaultSchedule()
  await sys.writeFile(`${PATHS.unitDir}/${BACKUP_SERVICE}`, renderBackupService(EE_NODE))
  await sys.writeFile(`${PATHS.unitDir}/${BACKUP_TIMER}`, renderBackupTimer(schedule))
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  await mustRun(sys, 'systemctl', ['enable', '--now', '--quiet', BACKUP_TIMER])
  await mustRun(sys, 'systemctl', ['restart', BACKUP_TIMER])
}

/**
 * `ee restore` on a box (run as root, normally right after `ee bootstrap` on a
 * fresh server): fetch + verify everything first, then stop the workloads and
 * ee, put back ee state, the database, Drive and the agent, and start ee —
 * whose reconcile re-renders env files, re-keys the DB role and redeploys.
 */
export async function restoreOnBox(sys: System, s3: S3Client, key: Buffer, id: string, log: (l: string) => void): Promise<Manifest> {
  const work = join(PATHS.backupTmp, `restore-${id}`)
  const staging = join(work, 'drive')
  await sys.remove(work)
  log(`→ downloading and verifying snapshot ${id}`)
  const m = await fetchSnapshot(s3, key, id, { dir: work, driveDir: staging }, log)
  const has = (n: string) => m.files.some((f) => f.name === n)
  if (!has('db.dump') || !has('ee-state.tar.gz')) throw new Error(`snapshot ${id} lacks the database or ee state; refusing a partial restore`)

  log('→ stopping ee and the workloads')
  await mustRun(sys, 'systemctl', ['stop', 'ee.service', BACKUP_TIMER])
  const units = (await mustRun(sys, 'systemctl', ['list-units', '--plain', '--no-legend', '--all', 'ee-*-?.service']))
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u && /^ee-[a-z0-9-]+-[ab]\.service$/.test(u))
  if (units.length) await mustRun(sys, 'systemctl', ['stop', ...units])

  log('→ restoring ee state (company repo, sealed secrets, host key)')
  await sys.remove(PATHS.company)
  await mustRun(sys, 'tar', ['-C', '/', '-xzf', join(work, 'ee-state.tar.gz')])
  // Runtime state is rebuilt by reconcile from the restored desired state.
  await sys.remove(PATHS.journal)

  log(`→ restoring the company database (${COMPANY_DB})`)
  await mustRun(sys, 'runuser', ['-u', 'postgres', '--', 'dropdb', '--if-exists', COMPANY_DB])
  // --create recreates the database (owner role "os" exists from bootstrap; reconcile re-keys its password).
  await runToFile(['runuser', '-u', 'postgres', '--', 'pg_restore', '--create', '--exit-on-error', '--dbname=postgres'], join(work, 'pg_restore.log'), {
    stdinFile: join(work, 'db.dump'),
  })

  log('→ restoring Drive and agent state')
  await sys.mkdirp(PATHS.osState, 0o755)
  const drive = join(PATHS.osState, 'drive')
  await sys.mkdirp(drive, 0o700)
  await mustRun(sys, 'cp', ['-a', `${staging}/.`, drive])
  if (has('agent.sqlite')) {
    const agentDir = join(PATHS.osState, 'agent')
    await sys.mkdirp(agentDir, 0o700)
    for (const f of ['agent.sqlite-wal', 'agent.sqlite-shm']) await sys.remove(join(agentDir, f))
    await mustRun(sys, 'cp', [join(work, 'agent.sqlite'), join(agentDir, 'agent.sqlite')])
  }
  // The os workload's (dynamic) user owns its state dir: hand the restored files to it.
  const owner = (await mustRun(sys, 'stat', ['-L', '-c', '%u:%g', PATHS.osState])).trim()
  await mustRun(sys, 'chown', ['-R', owner, `${PATHS.osState}/`])

  log('→ starting ee (it reconciles: env files, database role, deploy)')
  await mustRun(sys, 'systemctl', ['start', 'ee.service', BACKUP_TIMER])
  await sys.remove(work)
  return m
}
