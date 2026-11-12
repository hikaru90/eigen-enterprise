import type { S3Client } from './s3.ts'
import { join } from 'node:path'
import { AGE_REPAIR_SQL } from '../age-repair.ts'
import { PATHS } from '../paths.ts'
import { mustRun, type System } from '../system.ts'
import { RESTORE_UNIT, restoreWorkDir, stageSnapshot, type ApplyProgress } from './restore.ts'
import { runToFile, type BackupSources, type Manifest } from './snapshot.ts'
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
    // config) and the host key that unseals it: together they are ee. Plus the
    // os workload's git-native company data repo and its sealed company root key
    // (plan/phase-git-native.md; sealed under TENANT_MASTER_KEY, which lives in
    // the secret store above).
    eeState: [PATHS.company, PATHS.secrets, PATHS.masterKey, join(PATHS.osState, 'company-data'), join(PATHS.osState, 'company-keys')],
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
  log(`→ downloading and verifying snapshot ${id}`)
  const m = await stageSnapshot(s3, key, id, PATHS.backupTmp, log)
  await applyRestore(sys, id, async (_step, line) => log(line))
  return m
}

/** The restore unit Settings → Backups hands a verified, staged snapshot to (restore.ts): it outlives ee.service. */
export async function launchRestoreUnit(sys: System, id: string): Promise<void> {
  await mustRun(sys, 'systemd-run', [
    `--unit=${RESTORE_UNIT}`,
    '--description=eigenEnterprise restore (Settings → Backups)',
    '--collect',
    '--quiet',
    '--property=Type=exec',
    EE_NODE,
    '/opt/ee/ee.mjs',
    'restore-apply',
    '--snapshot',
    id,
  ])
}

export async function restoreUnitActive(sys: System): Promise<boolean> {
  return (await sys.run('systemctl', ['is-active', '--quiet', RESTORE_UNIT])).code === 0
}

/**
 * Put a staged, verified snapshot (stageSnapshot) in place: stop ee and every
 * workload, replace ee state, the database, Drive and the agent, start ee.
 * Needs no key — everything was decrypted and checked before.
 */
export async function applyRestore(sys: System, id: string, progress: ApplyProgress): Promise<void> {
  const work = restoreWorkDir(PATHS.backupTmp, id)
  const staging = join(work, 'drive')
  for (const f of ['db.dump', 'ee-state.tar.gz']) {
    if (!(await sys.exists(join(work, f)))) throw new Error(`snapshot ${id} is not staged (${join(work, f)} is missing); nothing was changed`)
  }

  await progress('stopping', '→ stopping ee and the workloads')
  await mustRun(sys, 'systemctl', ['stop', 'ee.service', BACKUP_TIMER])
  const units = (await mustRun(sys, 'systemctl', ['list-units', '--plain', '--no-legend', '--all', 'ee-*-?.service']))
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u): u is string => !!u && /^ee-[a-z0-9-]+-[ab]\.service$/.test(u))
  if (units.length) await mustRun(sys, 'systemctl', ['stop', ...units])

  await progress('restoring-state', '→ restoring ee state (company repo, sealed secrets, host key)')
  await sys.remove(PATHS.company)
  await mustRun(sys, 'tar', ['-C', '/', '-xzf', join(work, 'ee-state.tar.gz')])
  // Runtime state is rebuilt by reconcile from the restored desired state.
  await sys.remove(PATHS.journal)

  await progress('restoring-database', `→ restoring the company database (${COMPANY_DB})`)
  await mustRun(sys, 'runuser', ['-u', 'postgres', '--', 'dropdb', '--if-exists', COMPANY_DB])
  // --create recreates the database (owner role "os" exists from bootstrap; reconcile re-keys its password).
  await runToFile(['runuser', '-u', 'postgres', '--', 'pg_restore', '--create', '--exit-on-error', '--dbname=postgres'], join(work, 'pg_restore.log'), {
    stdinFile: join(work, 'db.dump'),
  })
  // A restore gives the graph's schema a new oid; point AGE's catalog at it (age-repair.ts).
  await mustRun(sys, 'runuser', ['-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-d', COMPANY_DB, '-c', AGE_REPAIR_SQL])

  await progress('restoring-files', '→ restoring Drive and agent state')
  await sys.mkdirp(PATHS.osState, 0o755)
  const drive = join(PATHS.osState, 'drive')
  await sys.mkdirp(drive, 0o700)
  await sys.mkdirp(staging, 0o700) // a snapshot without Drive blobs stages none
  await mustRun(sys, 'cp', ['-a', `${staging}/.`, drive])
  if (await sys.exists(join(work, 'agent.sqlite'))) {
    const agentDir = join(PATHS.osState, 'agent')
    await sys.mkdirp(agentDir, 0o700)
    for (const f of ['agent.sqlite-wal', 'agent.sqlite-shm']) await sys.remove(join(agentDir, f))
    await mustRun(sys, 'cp', [join(work, 'agent.sqlite'), join(agentDir, 'agent.sqlite')])
  }
  // The os workload's (dynamic) user owns its state dir: hand the restored files to it.
  const owner = (await mustRun(sys, 'stat', ['-L', '-c', '%u:%g', PATHS.osState])).trim()
  await mustRun(sys, 'chown', ['-R', owner, `${PATHS.osState}/`])

  await progress('starting', '→ starting ee (it reconciles: env files, database role, deploy)')
  await mustRun(sys, 'systemctl', ['start', 'ee.service', BACKUP_TIMER])
  await sys.remove(work)
}
