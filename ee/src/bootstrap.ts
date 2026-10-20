import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { newClaim } from './claim.ts'
import { CompanyRepo } from './company-repo.ts'
import { CONTROL_GROUP, PATHS } from './paths.ts'
import { OS_INTERNAL_PORT } from './reconcile.ts'
import { SecretStore } from './secret-store.ts'
import { generateSecret } from './secrets.ts'
import { workloadSchema } from './spec.ts'
import { mustRun, type System } from './system.ts'

/**
 * `ee bootstrap` (§5): turn a fresh Ubuntu 24.04 / Debian 13 box into a running
 * company. Every step is idempotent, so a failed install is fixed by re-running
 * it. Prints one named progress line per step — no silent spinners.
 */

export type BootstrapOptions = {
  /** Absolute path to the eigenEnterprise release tarball. */
  release: string
  /** Console host; when omitted, an IP-encoded sslip.io name for the box's public IPv4. */
  consoleHost?: string
  acmeEmail?: string
}

const PG = '16'
const PG_NET_VERSION = 'v0.14.0'
const NODE_MAJOR = '22'
const SUPPORTED = [
  { id: 'ubuntu', version: '24.04' },
  { id: 'debian', version: '13' },
]

const step = (label: string) => console.log(`→ ${label}`)

const apt = (sys: System, pkgs: string[]) =>
  mustRun(sys, 'env', ['DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', '-qq', '--no-install-recommends', ...pkgs], {
    timeoutMs: 900_000,
  })

async function assertSupportedOs(sys: System): Promise<void> {
  const osr = (await sys.readFile('/etc/os-release')) ?? ''
  const id = /^ID=(.*)$/m.exec(osr)?.[1]?.replace(/"/g, '')
  const version = /^VERSION_ID=(.*)$/m.exec(osr)?.[1]?.replace(/"/g, '')
  if (!SUPPORTED.some((s) => s.id === id && s.version === version)) {
    throw new Error(`unsupported OS ${id} ${version}: ee supports Ubuntu 24.04 LTS and Debian 13 (plan/phase-substrate.md §8.2)`)
  }
}

async function installPackages(sys: System): Promise<void> {
  step('installing base packages')
  await mustRun(sys, 'apt-get', ['update', '-qq'], { timeoutMs: 300_000 })
  await apt(sys, ['ca-certificates', 'curl', 'gnupg', 'git', 'openssh-client', 'postgresql-common', 'debian-keyring', 'debian-archive-keyring', 'apt-transport-https'])

  if (!(await sys.exists('/etc/apt/sources.list.d/pgdg.list')) && !(await sys.exists('/etc/apt/sources.list.d/pgdg.sources'))) {
    step('adding the official PostgreSQL apt repository')
    await mustRun(sys, '/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh', ['-y'], { timeoutMs: 300_000 })
  }
  if (!(await sys.exists('/etc/apt/sources.list.d/caddy-stable.list'))) {
    step('adding the Caddy apt repository')
    await mustRun(sys, 'sh', [
      '-c',
      "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && " +
        "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list",
    ])
    await mustRun(sys, 'apt-get', ['update', '-qq'], { timeoutMs: 300_000 })
  }
  step(`installing Postgres ${PG} + pgvector, pg_cron, Apache AGE, and Caddy`)
  await apt(sys, [`postgresql-${PG}`, `postgresql-${PG}-pgvector`, `postgresql-${PG}-cron`, `postgresql-${PG}-age`, 'caddy'])

  if (!(await sys.exists(`/usr/lib/postgresql/${PG}/lib/pg_net.so`))) {
    // pg_net is not packaged in PGDG; compiled from a pinned tag (same as Dockerfile.postgres).
    step(`compiling pg_net ${PG_NET_VERSION}`)
    await apt(sys, ['build-essential', 'libcurl4-openssl-dev', `postgresql-server-dev-${PG}`])
    await sys.remove('/tmp/ee-pg_net')
    await mustRun(sys, 'git', ['clone', '-q', '--depth', '1', '--branch', PG_NET_VERSION, 'https://github.com/supabase/pg_net.git', '/tmp/ee-pg_net'], {
      timeoutMs: 300_000,
    })
    await mustRun(sys, 'make', ['-C', '/tmp/ee-pg_net', `PG_CONFIG=/usr/lib/postgresql/${PG}/bin/pg_config`], { timeoutMs: 600_000 })
    await mustRun(sys, 'make', ['-C', '/tmp/ee-pg_net', 'install', `PG_CONFIG=/usr/lib/postgresql/${PG}/bin/pg_config`])
    await sys.remove('/tmp/ee-pg_net')
  }
}

async function configurePostgres(sys: System): Promise<void> {
  step('configuring Postgres (loopback only, extensions preloaded)')
  const conf = [
    '# Managed by ee. Postgres listens on loopback only — never on a public interface.',
    '# (Loopback, not a unix socket: every client library parses a host:port URL the same way.)',
    "listen_addresses = '127.0.0.1'",
    "shared_preload_libraries = 'age,pg_cron,pg_net'",
    "cron.database_name = 'os'",
    "pg_net.database_name = 'os'",
    "cron.timezone = 'UTC'",
    "password_encryption = 'scram-sha-256'",
    '',
  ].join('\n')
  const hba = [
    '# Managed by ee.',
    '# TYPE  DATABASE  USER      METHOD',
    'local   all       postgres  peer',
    'local   all       all       scram-sha-256',
    '# Each role reaches only its own database: CONNECT is revoked from PUBLIC per database.',
    'host    all       all       127.0.0.1/32  scram-sha-256',
    '',
  ].join('\n')
  const confPath = `/etc/postgresql/${PG}/main/conf.d/ee.conf`
  const hbaPath = `/etc/postgresql/${PG}/main/pg_hba.conf`
  const changed = (await sys.readFile(confPath)) !== conf || (await sys.readFile(hbaPath)) !== hba
  await sys.writeFile(confPath, conf, 0o644)
  await sys.writeFile(hbaPath, hba, 0o640)
  await mustRun(sys, 'chown', ['postgres:postgres', hbaPath])
  await mustRun(sys, 'systemctl', ['enable', '--quiet', 'postgresql'])
  if (changed) await mustRun(sys, 'systemctl', ['restart', 'postgresql'])
  else await mustRun(sys, 'systemctl', ['start', 'postgresql'])
  for (let i = 0; i < 30; i++) {
    if ((await sys.run('runuser', ['-u', 'postgres', '--', 'pg_isready', '-q'])).code === 0) return
    await sys.sleep(1000)
  }
  throw new Error('Postgres did not become ready within 30s (journalctl -u postgresql@16-main)')
}

async function usersAndDirs(sys: System): Promise<void> {
  step('creating ee users, groups and directories')
  await mustRun(sys, 'groupadd', ['-f', '--system', CONTROL_GROUP])
  if ((await sys.run('id', ['-u', 'ee-build'])).code !== 0) {
    await mustRun(sys, 'useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', 'ee-build'])
  }
  for (const d of [PATHS.root, PATHS.releases, PATHS.workloads, '/etc/ee']) await sys.mkdirp(d, 0o700)
  await mustRun(sys, 'chmod', ['711', PATHS.root, PATHS.workloads])
  if ((await sys.readFile(PATHS.masterKey)) === null) {
    await sys.writeFile(PATHS.masterKey, randomBytes(32).toString('base64') + '\n', 0o400)
  }
}

async function configureCaddy(sys: System): Promise<void> {
  step('configuring Caddy (driven by ee through its admin socket)')
  await sys.writeFile(
    '/etc/systemd/system/caddy.service.d/ee.conf',
    [
      '# Managed by ee: Caddy runs the config ee renders from the company repo.',
      '[Service]',
      'RuntimeDirectory=caddy',
      'RuntimeDirectoryPreserve=yes',
      'ExecStart=',
      `ExecStart=/usr/bin/caddy run --environ --config ${PATHS.caddyConfig}`,
      'ExecReload=',
      `ExecReload=/usr/bin/caddy reload --config ${PATHS.caddyConfig} --address unix/${PATHS.caddyAdminSocket} --force`,
      '',
    ].join('\n'),
  )
  if ((await sys.readFile(PATHS.caddyConfig)) === null) {
    await sys.writeFile(PATHS.caddyConfig, JSON.stringify({ admin: { listen: `unix/${PATHS.caddyAdminSocket}` } }) + '\n', 0o640)
  }
  await mustRun(sys, 'chown', ['root:caddy', PATHS.caddyConfig])
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  await mustRun(sys, 'systemctl', ['enable', '--quiet', 'caddy'])
  await mustRun(sys, 'systemctl', ['restart', 'caddy'])
  for (let i = 0; i < 20; i++) {
    if (await sys.exists(PATHS.caddyAdminSocket)) return
    await sys.sleep(500)
  }
  throw new Error(`Caddy admin socket ${PATHS.caddyAdminSocket} did not appear (journalctl -u caddy)`)
}

async function installEeService(sys: System): Promise<void> {
  step('installing ee.service')
  const node = `${PATHS.runtimes}/node-${NODE_MAJOR}/bin/node`
  await sys.writeFile(
    '/etc/systemd/system/ee-env.service',
    [
      '[Unit]',
      'Description=ee: render workload environment files before workloads start',
      'After=local-fs.target',
      'Before=multi-user.target',
      '',
      '[Service]',
      'Type=oneshot',
      'RemainAfterExit=yes',
      `ExecStart=${node} /opt/ee/ee.mjs render-env`,
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'),
  )
  await sys.writeFile(
    '/etc/systemd/system/ee.service',
    [
      '[Unit]',
      "Description=ee — the company's init (plan/phase-substrate.md)",
      'After=network-online.target postgresql.service caddy.service ee-env.service',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${node} /opt/ee/ee.mjs daemon`,
      'Restart=always',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'),
  )
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  await mustRun(sys, 'systemctl', ['enable', '--quiet', 'ee-env.service', 'ee.service'])
}

/** VAPID keys for web push (P-256), in the base64url forms web-push expects. */
function vapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pub = publicKey.export({ format: 'jwk' })
  const priv = privateKey.export({ format: 'jwk' })
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')])
  return { publicKey: raw.toString('base64url'), privateKey: priv.d! }
}

export async function detectPublicIpv4(sys: System): Promise<string> {
  const out = await mustRun(sys, 'ip', ['-4', 'route', 'get', '1.1.1.1'])
  const ip = /\bsrc (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1]
  if (!ip) throw new Error(`could not detect this box's IPv4 from \`ip route\`: ${out.trim()} — pass --console-host`)
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip)) {
    throw new Error(`this box's IPv4 ${ip} is private (behind NAT?) — pass --console-host with a domain that points here`)
  }
  return ip
}

export const OS_SECRETS = [
  'BETTER_AUTH_SECRET',
  'EIGEN_APP_DB_PASSWORD',
  'ADMIN_CONSOLIDATION_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
  'TENANT_MASTER_KEY',
] as const

/** Claim-link state (hash + expiry only), declared on os so the app can check a claim. */
export const CLAIM_SECRETS = ['EE_CLAIM_TOKEN_HASH', 'EE_CLAIM_EXPIRES_AT'] as const

async function seedCompany(sys: System, opts: BootstrapOptions, consoleHost: string): Promise<string | null> {
  step('installing the eigenEnterprise release')
  const tarball = `${PATHS.releases}/${basename(opts.release)}`
  if (opts.release !== tarball) await mustRun(sys, 'cp', [opts.release, tarball])
  const sha256 = await sys.sha256File(tarball)

  const secrets = await SecretStore.open(sys)
  const have = secrets.all()['os'] ?? {}
  const vapid = vapidKeys()
  const generated: Record<(typeof OS_SECRETS)[number], string> = {
    BETTER_AUTH_SECRET: generateSecret(32),
    EIGEN_APP_DB_PASSWORD: generateSecret(24),
    ADMIN_CONSOLIDATION_KEY: randomBytes(32).toString('hex'),
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: opts.acmeEmail ? `mailto:${opts.acmeEmail}` : `mailto:ops@${consoleHost}`,
    TENANT_MASTER_KEY: generateSecret(32),
  }
  for (const name of OS_SECRETS) {
    // VAPID keys are a pair: never regenerate one half.
    if (have[name] === undefined) await secrets.set('os', name, generated[name])
  }

  // First install only: mint the claim link. Re-runs never mint a new one (`ee claim-link` does).
  let claimToken: string | null = null
  if (have['EE_CLAIM_TOKEN_HASH'] === undefined) {
    const claim = newClaim()
    await secrets.set('os', 'EE_CLAIM_TOKEN_HASH', claim.hash)
    await secrets.set('os', 'EE_CLAIM_EXPIRES_AT', claim.expiresAt)
    claimToken = claim.token
  }

  step('writing the company repo')
  const repo = new CompanyRepo(sys, PATHS.company)
  await repo.init()
  await repo.commit('bootstrap: eigenEnterprise', 'ee-bootstrap', (s) => {
    const existing = s.workloads.find((w) => w.name === 'os')
    const os = workloadSchema.parse({
      name: 'os',
      tier: 'system',
      source: { kind: 'release', tarball, sha256 },
      env: {
        ...(existing?.env ?? {}),
        ORIGIN: existing?.env.ORIGIN ?? `https://${consoleHost}`,
        AGE_GRAPH_NAME: 'eigen_graph',
        APP_DB_ROLE: 'eigen_app',
        CONSOLIDATION_INTERNAL_URL: `http://127.0.0.1:${OS_INTERNAL_PORT}`,
        PROTOCOL_HEADER: 'x-forwarded-proto',
        HOST_HEADER: 'x-forwarded-host',
        XFF_DEPTH: '1',
        // The release has no .git: server changes are committed by ee in the company repo,
        // and kernel_events is the audit trail. The in-image autocommit has nothing to commit to.
        EE_VCS_AUTOCOMMIT: '0',
      },
      secrets: [...OS_SECRETS, ...CLAIM_SECRETS],
      resources: { memoryMb: 2048, cpuPercent: 200 },
    })
    const firstRun = !existing
    return {
      workloads: [...s.workloads.filter((w) => w.name !== 'os'), os],
      routes: firstRun ? [{ host: consoleHost, workload: 'os' }] : s.routes,
      settings: firstRun ? { consoleHost, publicHost: null, acmeEmail: opts.acmeEmail ?? null } : s.settings,
    }
  })
  return claimToken
}

export async function bootstrap(
  sys: System,
  opts: BootstrapOptions,
): Promise<{ consoleHost: string; claimToken: string | null }> {
  if (process.getuid?.() !== 0) throw new Error('ee bootstrap must run as root')
  await assertSupportedOs(sys)
  if (!(await sys.exists(opts.release))) throw new Error(`release tarball ${opts.release} not found`)
  await installPackages(sys)
  await usersAndDirs(sys)
  await configurePostgres(sys)
  await configureCaddy(sys)
  await installEeService(sys)
  // Re-runs (upgrades, repairs) keep the console host the company already has.
  const repo = new CompanyRepo(sys, PATHS.company)
  const existing = (await repo.head()) ? (await repo.read()).settings.consoleHost : null
  const consoleHost =
    opts.consoleHost ?? existing ?? `${(await detectPublicIpv4(sys)).replace(/\./g, '-')}.sslip.io`
  const claimToken = await seedCompany(sys, opts, consoleHost)
  return { consoleHost, claimToken }
}
