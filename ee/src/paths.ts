/** Every filesystem location ee owns. One place, so tests and docs agree. */
export const PATHS = {
  root: '/var/lib/ee',
  company: '/var/lib/ee/company',
  releases: '/var/lib/ee/releases',
  workloads: '/var/lib/ee/workloads',
  journal: '/var/lib/ee/journal.json',
  secrets: '/var/lib/ee/secrets.enc',
  /** Short-lived ssh material (deploy key + pinned known_hosts) for one git call; 0700, emptied after. */
  sshTmp: '/var/lib/ee/ssh-tmp',
  masterKey: '/etc/ee/master.key',
  runtimes: '/opt/ee/runtimes',
  envDir: '/run/ee/env',
  /** Root-only env files for one build step each (removed right after). */
  buildEnvDir: '/run/ee/build-env',
  controlSocketDir: '/run/ee/control',
  controlSocket: '/run/ee/control/ee.sock',
  unitDir: '/etc/systemd/system',
  caddyConfig: '/etc/caddy/ee.json',
  caddyAdminSocket: '/run/caddy/admin.sock',
  postgresSocketDir: '/var/run/postgresql',
  /** Backup run records (plan/phase-backups.md); config + key live sealed in the secret store. */
  backupRuns: '/var/lib/ee/backups.json',
  /** Root-only scratch for one backup/restore run (emptied after). */
  backupTmp: '/var/lib/ee/backup-tmp',
  /** The os workload's persistent state (Drive under drive/, the agent under agent/). */
  osState: '/var/lib/ee-state/os',
} as const

export const CONTROL_GROUP = 'ee-control'
