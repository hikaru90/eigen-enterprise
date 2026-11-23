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
  /**
   * Caddy's data directory (certificates, ACME account, locks). The default of the
   * Debian package's caddy user ($HOME/.local/share/caddy), pinned in the rendered
   * config so ee reads certificates from where Caddy writes them (certificates.ts).
   */
  caddyStorage: '/var/lib/caddy/.local/share/caddy',
  postgresSocketDir: '/var/run/postgresql',
  /** Backup run records (plan/phase-backups.md); config + key live sealed in the secret store. */
  backupRuns: '/var/lib/ee/backups.json',
  /** The last check/restore job from Settings → Backups (backup/restore.ts); outlives the restore's restart. */
  restoreState: '/var/lib/ee/restore.json',
  /** The last update from Settings → Updates (upgrade-job.ts); outlives the update's restarts. */
  upgradeState: '/var/lib/ee/upgrade.json',
  /** Managed boxes: the company's domain claims as the control plane last sent them (fleet/claims.ts). */
  fleetClaims: '/var/lib/ee/fleet-claims.json',
  /** Managed boxes: the free hosted address the control plane last sent + the public host the fleet added (fleet/hosted-address.ts). */
  fleetHostedAddress: '/var/lib/ee/fleet-hosted-address.json',
  /** Root-only scratch for one backup/restore run (emptied after). */
  backupTmp: '/var/lib/ee/backup-tmp',
  /**
   * Drive app previews (previews.ts): incoming/ holds ee's root-only copies of
   * the kernel's snapshots; <id>-<ms>/ is one run's working dir (owned by
   * ee-preview). Wiped on every ee start: previews are never restored.
   */
  previews: '/var/lib/ee/previews',
  /** npm / corepack / pnpm / yarn caches the preview installs share (owned by ee-preview; kept across runs). */
  previewCache: '/var/lib/ee/preview-cache',
  /** The os workload's persistent state (Drive under drive/, the agent under agent/). */
  osState: '/var/lib/ee-state/os',
} as const

export const CONTROL_GROUP = 'ee-control'
