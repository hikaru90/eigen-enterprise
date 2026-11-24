import type { ReleaseSource } from './release-source.ts'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { basename } from 'node:path'
import { writeBackupTimer } from './backup/box.ts'
import { BACKUP_SCOPE, storedConfigSchema } from './backup/service.ts'
import { OS_BODY_SIZE_LIMIT } from './body-limit.ts'
import { OS_EMBEDDING_COMPRESS_INTENSITY } from './embedding-compress.ts'
import { claimFromHash, newClaim } from './claim.ts'
import { CompanyRepo, ipv4CidrSchema, type DesiredState, type Settings } from './company-repo.ts'
import { assertContainerHostReady, detectContainer } from './container.ts'
import { contributeHubEnv, resolveContributeHub, type ContributeHub } from './contribute-hub.ts'
import { withCallsHost } from './domains.ts'
import { moduleHubEnv, resolveModuleHub } from './hub-key.ts'
import { LIVEKIT_SECRETS, LIVEKIT_WORKLOAD, generateLivekitKeys, livekitWorkload } from './livekit.ts'
import { CONTROL_GROUP, PATHS } from './paths.ts'
import { PREVIEW_USER } from './previews.ts'
import { OS_INTERNAL_PORT } from './reconcile.ts'
import { SecretStore } from './secret-store.ts'
import { generateSecret } from './secrets.ts'
import { DEFAULT_RTC_PORTS, HOSTED_RTC_PORT_RANGE, rtcPortsSchema, workloadSchema, type RtcPorts, type WorkloadInput } from './spec.ts'
import { mustRun, type System } from './system.ts'

/**
 * `ee bootstrap` (§5): turn a fresh Ubuntu 24.04 / Debian 13 box into a running
 * company. Every step is idempotent, so a failed install is fixed by re-running
 * it. Prints one named progress line per step — no silent spinners.
 */

export type BootstrapOptions = {
  /** Absolute path to the eigenEnterprise release tarball. */
  release: string
  /** Absolute path to the livekit-server release tarball (scripts/release.sh packs it). */
  livekitRelease: string
  /** Console host; when omitted, an IP-encoded sslip.io name for the box's public IPv4. */
  consoleHost?: string
  acmeEmail?: string
  /** The IP LiveKit advertises for media; required on the first install, kept on re-runs. */
  nodeIp?: string
  /** The central Contribute board, or 'off' (contribute-hub.ts); when omitted, the company's saved one. */
  contributeHub?: ContributeHub
  /** Where this release came from (install.sh's --from); kept on re-runs that do not pass it. */
  releaseSource?: ReleaseSource
  /** LiveKit's media host ports; when omitted, the company's (7881/7882 on a first install). */
  rtcPorts?: RtcPorts
  /** The router in front of this box (IPv4 CIDR, PROXY protocol); when omitted, the company's (none on a first install). */
  trustedProxy?: string
  /** First install only: the SHA-256 of a claim token minted by whoever set up this server. */
  claimHash?: string
  /** The module hub (hub-key.ts): `--module-hub <origin>` / `--module-hub-key <spki>`; when omitted, the company's. */
  moduleHub?: { origin?: string; keys?: string[] }
}

/**
 * The node IP for LiveKit: an explicit --node-ip wins, else the one the company
 * already has. Never guessed — a NAT'd or multi-homed box would advertise the
 * wrong one and calls would connect signalling but never media.
 */
export function resolveNodeIp(flag: string | undefined, stored: string | null): string {
  const ip = flag ?? stored
  if (!ip) {
    throw new Error(
      'calls need the IP media reaches this server on: pass --node-ip <public IP of this server> ' +
        '(and open 7881/tcp + 7882/udp in its firewall)',
    )
  }
  if (isIP(ip) === 0) throw new Error(`--node-ip "${ip}" is not an IP address`)
  return ip
}

/** `--rtc-ports <tcp>,<udp>`, checked in plain words. */
export function parseRtcPortsFlag(raw: string): RtcPorts {
  const m = /^(\d{1,5}),(\d{1,5})$/.exec(raw.trim())
  const parsed = m ? rtcPortsSchema.safeParse({ tcp: Number(m[1]), udp: Number(m[2]) }) : null
  if (!parsed?.success) {
    throw new Error(
      `--rtc-ports "${raw}" is not valid: pass <tcp>,<udp> — either ${DEFAULT_RTC_PORTS.tcp},${DEFAULT_RTC_PORTS.udp} ` +
        `or two different ports between ${HOSTED_RTC_PORT_RANGE.min} and ${HOSTED_RTC_PORT_RANGE.max}`,
    )
  }
  return parsed.data
}

/** LiveKit's media ports: an explicit --rtc-ports wins, else the company's, else 7881/7882. */
export function resolveRtcPorts(flag: RtcPorts | undefined, stored: RtcPorts | null): RtcPorts {
  return rtcPortsSchema.parse(flag ?? stored ?? DEFAULT_RTC_PORTS)
}

/** `--trusted-proxy <IPv4 CIDR>`, checked in plain words. */
export function parseTrustedProxyFlag(raw: string): string {
  if (!ipv4CidrSchema.safeParse(raw).success) {
    throw new Error(`--trusted-proxy "${raw}" is not an IPv4 CIDR (e.g. 10.0.0.1/32: the router in front of this server)`)
  }
  return raw
}

/** The router in front of the box: an explicit --trusted-proxy wins, else the company's (null = none). */
export function resolveTrustedProxy(flag: string | undefined, stored: string | null): string | null {
  return flag ?? stored
}

/** `--claim-hash` seeds the first install's claim; on a company that already exists it would do nothing, so it is refused. */
export function assertClaimHashAllowed(claimHash: string | undefined, seeded: boolean): void {
  if (claimHash !== undefined && seeded) {
    throw new Error(
      '--claim-hash only works on the first install: this server already has a company (and its claim link). ' +
        'Re-run without --claim-hash; for a new link run: ee claim-link',
    )
  }
}

type SeedState = Omit<DesiredState, 'rev'>

/** Put the livekit workload (this release) in the company, save the node IP and media ports, and route the calls host. */
export function withLivekit(s: SeedState, livekit: WorkloadInput, nodeIp: string, rtcPorts: RtcPorts): SeedState {
  const w = workloadSchema.parse(livekit)
  return withCallsHost({
    workloads: [...s.workloads.filter((x) => x.name !== w.name), w],
    routes: s.routes,
    settings: { ...s.settings, rtcNodeIp: nodeIp, rtcPorts },
  })
}

const PG = '16'
const PG_NET_VERSION = 'v0.14.0'
const NODE_MAJOR = '22'
const SUPPORTED = [
  { id: 'ubuntu', version: '24.04' },
  { id: 'debian', version: '13' },
]

const step = (label: string) => console.log(`→ ${label}`)

/**
 * Installs what is missing and never upgrades what is installed: a re-run is
 * how a server upgrades eigenEnterprise, and an apt upgrade of Postgres or
 * Caddy would restart them under the running company. OS package updates are
 * the OS's job (unattended-upgrades), not ee's.
 */
export const aptInstallArgs = (pkgs: string[]) => [
  'DEBIAN_FRONTEND=noninteractive',
  'apt-get',
  'install',
  '-y',
  '-qq',
  '--no-install-recommends',
  '--no-upgrade',
  ...pkgs,
]

const apt = (sys: System, pkgs: string[]) => mustRun(sys, 'env', aptInstallArgs(pkgs), { timeoutMs: 900_000 })

/** Restart Caddy only when its unit changed; a re-run otherwise keeps it serving (no dropped requests). */
/**
 * Debian's postgresql-common (278, trixie) enables `pg_receivewal@<cluster>` for every cluster. ee never
 * archives WAL that way (backups are ee's own, src/backup), and the slot it creates on first start stays
 * inactive once ee's pg_hba.conf has no replication line, so Postgres keeps every WAL file for it and the
 * disk fills. Masked (a package upgrade cannot switch it on again), stopped, and its own slot dropped.
 */
export function strayWalArchiverOff(pg: string): { mask: string[]; stop: string[]; dropSlotSql: string } {
  const unit = `pg_receivewal@${pg}-main.service`
  return {
    mask: ['mask', '--quiet', unit],
    stop: ['stop', unit],
    dropSlotSql: "select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = 'pg_receivewal_service' and not active",
  }
}

export function caddyUnitAction(previous: string | null, next: string): 'restart' | 'start' {
  return previous === next ? 'start' : 'restart'
}

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
  // iproute2 + nftables: the Drive app preview network (preview-net.ts).
  await apt(sys, ['ca-certificates', 'curl', 'gnupg', 'git', 'openssh-client', 'iproute2', 'nftables', 'postgresql-common', 'debian-keyring', 'debian-archive-keyring', 'apt-transport-https'])

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
    // Newer curl headers (Debian 13) type-check curl_easy_setopt; pg_net builds with
    // -Werror, so that one warning must stay a warning (the calls are correct).
    await mustRun(sys, 'make', ['-C', '/tmp/ee-pg_net', `PG_CONFIG=/usr/lib/postgresql/${PG}/bin/pg_config`, 'COPT=-Wno-error=attribute-warning'], { timeoutMs: 600_000 })
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
    if ((await sys.run('runuser', ['-u', 'postgres', '--', 'pg_isready', '-q'])).code === 0) {
      const off = strayWalArchiverOff(PG)
      await mustRun(sys, 'systemctl', off.mask)
      // Not loaded on a host whose postgresql-common never shipped it: nothing to stop then.
      await sys.run('systemctl', off.stop)
      await mustRun(sys, 'runuser', ['-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1', '-qAtc', off.dropSlotSql])
      return
    }
    await sys.sleep(1000)
  }
  throw new Error('Postgres did not become ready within 30s (journalctl -u postgresql@16-main)')
}

/** The unprivileged users ee's sandboxed units run as. */
export const SANDBOX_USERS = ['ee-build', PREVIEW_USER] as const

/** A system user with no home and no shell; idempotent (a bootstrap re-run keeps an existing one). */
export async function ensureSystemUser(sys: System, user: string): Promise<void> {
  if ((await sys.run('id', ['-u', user])).code === 0) return
  await mustRun(sys, 'useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', user])
}

async function usersAndDirs(sys: System): Promise<void> {
  step('creating ee users, groups and directories')
  await mustRun(sys, 'groupadd', ['-f', '--system', CONTROL_GROUP])
  // ee-build runs release builds; ee-preview runs Drive app previews (previews.ts). Re-runs (upgrades) add missing ones.
  for (const user of SANDBOX_USERS) await ensureSystemUser(sys, user)
  for (const d of [PATHS.root, PATHS.releases, PATHS.workloads, '/etc/ee']) await sys.mkdirp(d, 0o700)
  await mustRun(sys, 'chmod', ['711', PATHS.root, PATHS.workloads])
  if ((await sys.readFile(PATHS.masterKey)) === null) {
    await sys.writeFile(PATHS.masterKey, randomBytes(32).toString('base64') + '\n', 0o400)
  }
}

async function configureCaddy(sys: System): Promise<void> {
  step('configuring Caddy (driven by ee through its admin socket)')
  const dropInPath = '/etc/systemd/system/caddy.service.d/ee.conf'
  const dropIn = [
    '# Managed by ee: Caddy runs the config ee renders from the company repo.',
    '[Service]',
    'RuntimeDirectory=caddy',
    'RuntimeDirectoryPreserve=yes',
    'ExecStart=',
    `ExecStart=/usr/bin/caddy run --environ --config ${PATHS.caddyConfig}`,
    'ExecReload=',
    `ExecReload=/usr/bin/caddy reload --config ${PATHS.caddyConfig} --address unix/${PATHS.caddyAdminSocket} --force`,
    '',
  ].join('\n')
  const action = caddyUnitAction(await sys.readFile(dropInPath), dropIn)
  await sys.writeFile(dropInPath, dropIn)
  if ((await sys.readFile(PATHS.caddyConfig)) === null) {
    await sys.writeFile(PATHS.caddyConfig, JSON.stringify({ admin: { listen: `unix/${PATHS.caddyAdminSocket}` } }) + '\n', 0o640)
  }
  await mustRun(sys, 'chown', ['root:caddy', PATHS.caddyConfig])
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  await mustRun(sys, 'systemctl', ['enable', '--quiet', 'caddy'])
  await mustRun(sys, 'systemctl', [action, 'caddy'])
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

/** The nightly backup timer; an upgrade keeps the owner's schedule (sealed with the backup config). */
async function installBackupTimer(sys: System): Promise<void> {
  step('installing the nightly backup timer')
  const raw = (await SecretStore.open(sys)).all()[BACKUP_SCOPE]?.['CONFIG']
  await writeBackupTimer(sys, raw ? storedConfigSchema.parse(JSON.parse(raw)).schedule : null)
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

/**
 * os's declared secrets after a (re-)run: the bootstrap set, plus whatever the fleet or the owner
 * declared since (the loopback token, managed mail, platform AI, `ee secret set`) while it still
 * has a value. Rebuilding the list from the bootstrap set alone dropped those on every upgrade.
 */
export function resolveOsSecrets(base: readonly string[], declared: readonly string[] | null, values: Record<string, string>): string[] {
  return [...new Set([...base, ...(declared ?? []).filter((n) => values[n] !== undefined)])]
}

/** Copy a release tarball into ee's releases dir (once) and return where it is and its checksum. */
async function installTarball(sys: System, src: string): Promise<{ tarball: string; sha256: string }> {
  const tarball = `${PATHS.releases}/${basename(src)}`
  if (src !== tarball) await mustRun(sys, 'cp', [src, tarball])
  return { tarball, sha256: await sys.sha256File(tarball) }
}

type Claim = { token: string | null; issuedElsewhere: boolean }

async function seedCompany(
  sys: System,
  opts: BootstrapOptions,
  consoleHost: string,
  net: { nodeIp: string; rtcPorts: RtcPorts; trustedProxy: string | null },
): Promise<Claim> {
  step('installing the eigenEnterprise release')
  const { tarball, sha256 } = await installTarball(sys, opts.release)
  step('installing the livekit-server release (calls)')
  const livekit = await installTarball(sys, opts.livekitRelease)

  const secrets = await SecretStore.open(sys)
  // LiveKit's API key + secret: generated once, shared by livekit (its config) and os (tokens, webhook check).
  const haveLivekit = secrets.all()[LIVEKIT_WORKLOAD] ?? {}
  const livekitKeys = generateLivekitKeys()
  for (const name of LIVEKIT_SECRETS) {
    if (haveLivekit[name] === undefined) await secrets.set(LIVEKIT_WORKLOAD, name, livekitKeys[name])
  }
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
  // With --claim-hash, whoever set up the server minted the token; only its hash lands here.
  const claimed: Claim = { token: null, issuedElsewhere: false }
  if (have['EE_CLAIM_TOKEN_HASH'] === undefined) {
    const claim = opts.claimHash !== undefined ? { ...claimFromHash(opts.claimHash), token: null } : newClaim()
    await secrets.set('os', 'EE_CLAIM_TOKEN_HASH', claim.hash)
    await secrets.set('os', 'EE_CLAIM_EXPIRES_AT', claim.expiresAt)
    claimed.token = claim.token
    claimed.issuedElsewhere = opts.claimHash !== undefined
  } else if (opts.claimHash !== undefined) {
    throw new Error('--claim-hash only works on the first install: this server already has a claim link (ee claim-link makes a new one)')
  }

  step('writing the company repo')
  const repo = new CompanyRepo(sys, PATHS.company)
  await repo.init()
  await repo.commit('bootstrap: eigenEnterprise', 'ee-bootstrap', (s) => {
    const existing = s.workloads.find((w) => w.name === 'os')
    const routing = bootstrapRouting(
      existing ? { routes: s.routes, settings: s.settings, origin: existing.env.ORIGIN ?? `https://${s.settings.consoleHost}` } : null,
      { consoleHost, explicitHost: opts.consoleHost !== undefined, ...(opts.acmeEmail ? { acmeEmail: opts.acmeEmail } : {}) },
    )
    const contributeHub = resolveContributeHub(opts.contributeHub, s.settings.contributeHub)
    const moduleHub = resolveModuleHub(opts.moduleHub ?? {}, s.settings.moduleHub)
    const os = workloadSchema.parse({
      name: 'os',
      tier: 'system',
      source: { kind: 'release', tarball, sha256 },
      env: moduleHubEnv(contributeHubEnv({
        ...(existing?.env ?? {}),
        ORIGIN: routing.origin,
        AGE_GRAPH_NAME: 'eigen_graph',
        APP_DB_ROLE: 'eigen_app',
        CONSOLIDATION_INTERNAL_URL: `http://127.0.0.1:${OS_INTERNAL_PORT}`,
        PROTOCOL_HEADER: 'x-forwarded-proto',
        HOST_HEADER: 'x-forwarded-host',
        XFF_DEPTH: '1',
        // The release has no .git: server changes are committed by ee in the company repo,
        // and kernel_events is the audit trail. The in-image autocommit has nothing to commit to.
        EE_VCS_AUTOCOMMIT: '0',
        // Drive uploads: adapter-node's 512K default would refuse them (see body-limit.ts).
        BODY_SIZE_LIMIT: OS_BODY_SIZE_LIMIT,
        // The app refuses to embed without it; without it no thought is ever indexed.
        EMBEDDING_COMPRESS_INTENSITY: OS_EMBEDDING_COMPRESS_INTENSITY,
      }, contributeHub), moduleHub),
      secrets: resolveOsSecrets([...OS_SECRETS, ...CLAIM_SECRETS], existing?.secrets ?? null, secrets.all()['os'] ?? {}),
      resources: { memoryMb: 2048, cpuPercent: 200 },
    })
    return withLivekit(
      {
        workloads: [...s.workloads.filter((w) => w.name !== 'os'), os],
        routes: routing.routes,
        settings: {
          ...s.settings,
          ...routing.settings,
          contributeHub,
          moduleHub,
          trustedProxy: net.trustedProxy,
          releaseSource: opts.releaseSource ?? s.settings.releaseSource,
        },
      },
      livekitWorkload(livekit.tarball, livekit.sha256, net.rtcPorts),
      net.nodeIp,
      net.rtcPorts,
    )
  })
  return claimed
}

type Routing = {
  routes: Array<{ host: string; workload: string }>
  settings: { consoleHost: string; publicHost: string | null; acmeEmail: string | null }
  origin: string
}

/**
 * What a bootstrap (re-)run saves for the console. A plain re-run keeps what the
 * company has; an EXPLICIT --console-host / --acme-email is applied (never silently
 * ignored): the console moves there, ORIGIN follows, and the old host keeps working.
 */
export function bootstrapRouting(
  prior: Routing | null,
  i: { consoleHost: string; explicitHost?: boolean; acmeEmail?: string },
): Routing {
  if (!prior) {
    return {
      routes: [{ host: i.consoleHost, workload: 'os' }],
      settings: { consoleHost: i.consoleHost, publicHost: null, acmeEmail: i.acmeEmail ?? null },
      origin: `https://${i.consoleHost}`,
    }
  }
  const move = i.explicitHost === true && i.consoleHost !== prior.settings.consoleHost
  const routes = move && !prior.routes.some((r) => r.host === i.consoleHost)
    ? [...prior.routes, { host: i.consoleHost, workload: 'os' }]
    : prior.routes
  return {
    routes,
    settings: {
      ...prior.settings,
      ...(move ? { consoleHost: i.consoleHost } : {}),
      ...(i.acmeEmail ? { acmeEmail: i.acmeEmail } : {}),
    },
    origin: move ? `https://${i.consoleHost}` : prior.origin,
  }
}

export async function bootstrap(
  sys: System,
  opts: BootstrapOptions,
): Promise<{ consoleHost: string; claimToken: string | null; claimIssuedElsewhere: boolean }> {
  if (process.getuid?.() !== 0) throw new Error('ee bootstrap must run as root')
  await assertSupportedOs(sys)
  // Hosted (unprivileged Incus container, D8): kernel tunables are the host's; refuse before installing if it lacks them.
  await assertContainerHostReady(sys, await detectContainer(sys), step)
  if (!(await sys.exists(opts.release))) throw new Error(`release tarball ${opts.release} not found`)
  if (!(await sys.exists(opts.livekitRelease))) throw new Error(`livekit-server release tarball ${opts.livekitRelease} not found`)
  // Before anything is installed: a first install (or an upgrade from before calls) must name the node IP.
  // (The repo exists only where git is installed: a fresh box has neither.)
  const company = new CompanyRepo(sys, PATHS.company)
  const stored: Settings | null =
    (await sys.exists(`${PATHS.company}/.git`)) && (await company.head()) ? (await company.read()).settings : null
  assertClaimHashAllowed(opts.claimHash, stored !== null)
  const nodeIp = resolveNodeIp(opts.nodeIp, stored?.rtcNodeIp ?? null)
  const rtcPorts = resolveRtcPorts(opts.rtcPorts, stored?.rtcPorts ?? null)
  const trustedProxy = resolveTrustedProxy(opts.trustedProxy, stored?.trustedProxy ?? null)
  await installPackages(sys)
  await usersAndDirs(sys)
  await configurePostgres(sys)
  await configureCaddy(sys)
  await installEeService(sys)
  await installBackupTimer(sys)
  // Re-runs (upgrades, repairs) keep the console host the company already has.
  const repo = new CompanyRepo(sys, PATHS.company)
  const existing = (await repo.head()) ? (await repo.read()).settings.consoleHost : null
  const consoleHost =
    opts.consoleHost ?? existing ?? `${(await detectPublicIpv4(sys)).replace(/\./g, '-')}.sslip.io`
  const claim = await seedCompany(sys, opts, consoleHost, { nodeIp, rtcPorts, trustedProxy })
  return { consoleHost, claimToken: claim.token, claimIssuedElsewhere: claim.issuedElsewhere }
}
