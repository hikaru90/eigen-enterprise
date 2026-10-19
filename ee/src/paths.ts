/** Every filesystem location ee owns. One place, so tests and docs agree. */
export const PATHS = {
  root: '/var/lib/ee',
  company: '/var/lib/ee/company',
  releases: '/var/lib/ee/releases',
  workloads: '/var/lib/ee/workloads',
  journal: '/var/lib/ee/journal.json',
  secrets: '/var/lib/ee/secrets.enc',
  masterKey: '/etc/ee/master.key',
  runtimes: '/opt/ee/runtimes',
  envDir: '/run/ee/env',
  controlSocketDir: '/run/ee/control',
  controlSocket: '/run/ee/control/ee.sock',
  unitDir: '/etc/systemd/system',
  caddyConfig: '/etc/caddy/ee.json',
  caddyAdminSocket: '/run/caddy/admin.sock',
  postgresSocketDir: '/var/run/postgresql',
} as const

export const CONTROL_GROUP = 'ee-control'
