import { createHash, randomUUID } from 'node:crypto'
import { renderCaddyConfig, type Upstream } from './caddy.ts'
import type { CompanyRepo, DesiredState } from './company-repo.ts'
import { saveJournal, workloadEntry, type EeEvent, type Journal } from './journal.ts'
import { CONTROL_GROUP, PATHS } from './paths.ts'
import { generateSecret, renderEnvFile, type SecretMap } from './secrets.ts'
import { appContractSchema, assertInCatalog, type AppContract, type Workload } from './spec.ts'
import { mustRun, type System } from './system.ts'
import { renderUnit, unitName, type Slot } from './units.ts'

/**
 * The reconciler (§3.2, §3.4): converge the box to the company repo's HEAD.
 * Level-triggered and idempotent — a crash at any point converges on the next pass.
 */

export type SecretAccess = {
  all(): SecretMap
  set(workload: string, name: string, value: string): Promise<void>
}

export type ReconcileContext = {
  sys: System
  repo: Pick<CompanyRepo, "read">
  journal: Journal
  secrets: SecretAccess
  /** Health-gate deadline per candidate. */
  healthTimeoutMs?: number
  /** Collects deploys that failed while an older release kept serving (reported, not fatal to the edge). */
  deployFailures?: string[]
}

export type PreparedRelease = { id: string; dir: string; contract: AppContract }

/** pg_cron/pg_net reach eigenEnterprise here, whichever slot is live. */
export const OS_INTERNAL_PORT = 4000

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export function emit(j: Journal, sys: System, type: string, workload: string | null, message: string, data = {}): EeEvent {
  const e: EeEvent = { id: randomUUID(), time: sys.now().toISOString(), type, workload, message, data }
  j.events.push(e)
  return e
}

function nodeBin(contract: AppContract): string {
  return `${PATHS.runtimes}/node-${contract.node}/bin`
}

async function readContract(sys: System, dir: string, name: string): Promise<AppContract> {
  const raw = await sys.readFile(`${dir}/ee.json`)
  if (raw === null) {
    throw new Error(`${name}: release has no ee.json — every workload declares how it builds and runs (D6)`)
  }
  const parsed = appContractSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) throw new Error(`${name}: ee.json is invalid: ${parsed.error.message}`)
  assertInCatalog(parsed.data)
  return parsed.data
}

/** Run build steps in a transient, sandboxed systemd unit as the unprivileged ee-build user. */
async function sandboxedBuild(sys: System, w: Workload, dir: string, contract: AppContract): Promise<void> {
  if (contract.build.length === 0) return
  await mustRun(sys, 'chown', ['-R', 'ee-build:ee-build', dir])
  for (const step of contract.build) {
    const [program, ...args] = step
    if (!program) throw new Error(`${w.name}: empty build step`)
    const resolved = program === 'node' || program === 'npm' || program === 'npx' ? `${nodeBin(contract)}/${program}` : program
    const r = await sys.run(
      'systemd-run',
      [
        '--wait',
        '--pipe',
        '--collect',
        '--quiet',
        `--unit=ee-build-${w.name}-${Date.now()}`,
        '-p', 'User=ee-build',
        '-p', 'Group=ee-build',
        '-p', 'NoNewPrivileges=yes',
        '-p', 'ProtectSystem=strict',
        '-p', 'ProtectHome=yes',
        '-p', 'PrivateTmp=yes',
        '-p', 'PrivateDevices=yes',
        '-p', `ReadWritePaths=${dir}`,
        '-p', `MemoryMax=${Math.max(w.resources.memoryMb, 1536)}M`,
        '-p', 'RuntimeMaxSec=1200',
        `--working-directory=${dir}`,
        '-E', `PATH=${nodeBin(contract)}:/usr/bin:/bin`,
        '-E', 'HOME=/tmp',
        '-E', 'NODE_ENV=production',
        '-E', 'npm_config_cache=/tmp/npm-cache',
        resolved,
        ...args,
      ],
      { timeoutMs: 1_260_000 },
    )
    if (r.code !== 0) {
      throw new Error(`${w.name}: build step \`${step.join(' ')}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-3000)}`)
    }
  }
  await mustRun(sys, 'chown', ['-R', 'root:root', dir])
}

export async function prepareRelease(sys: System, w: Workload): Promise<PreparedRelease> {
  const id = w.source.kind === 'release' ? w.source.sha256.slice(0, 16) : w.source.rev.slice(0, 16)
  const dir = `${PATHS.workloads}/${w.name}/releases/${id}`
  if (await sys.exists(`${dir}/.ee-ready`)) {
    return { id, dir, contract: await readContract(sys, dir, w.name) }
  }
  // Own temp dir per unpack: the CLI's first deploy and the daemon's tick can
  // prepare the same release at once; a shared .partial dir corrupts both.
  const tmp = `${dir}.partial-${process.pid}-${randomUUID().slice(0, 8)}`
  await sys.mkdirp(tmp)
  if (w.source.kind === 'release') {
    const actual = await sys.sha256File(w.source.tarball)
    if (actual !== w.source.sha256) {
      throw new Error(`${w.name}: release checksum mismatch (expected ${w.source.sha256}, got ${actual})`)
    }
    await mustRun(sys, 'tar', ['-xzf', w.source.tarball, '-C', tmp, '--no-same-owner'])
  } else {
    const mirror = `${PATHS.company}/${w.source.mirror}`
    // git archive | tar: the release never contains .git, only the tree at that rev.
    await mustRun(sys, 'sh', ['-c', 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3" --no-same-owner', 'sh', mirror, w.source.rev, tmp])
  }
  const contract = await readContract(sys, tmp, w.name)
  await sandboxedBuild(sys, w, tmp, contract)
  await mustRun(sys, 'chmod', ['-R', 'a+rX,go-w', tmp])
  await sys.writeFile(`${tmp}/.ee-ready`, `${id}\n`)
  // Another unpack of the same release finished first: keep its copy.
  if (await sys.exists(`${dir}/.ee-ready`)) {
    await sys.remove(tmp)
    return { id, dir, contract: await readContract(sys, dir, w.name) }
  }
  await sys.remove(dir)
  await mustRun(sys, 'mv', [tmp, dir])
  return { id, dir, contract }
}

/** The env a workload gets for its own database (pure: also used at boot by render-env). */
export function databaseEnv(w: Workload, password: string): Record<string, string> {
  const role = w.name.replace(/-/g, '_')
  const url = `postgres://${role}:${password}@127.0.0.1:5432/${role}`
  return w.tier === 'system' ? { DATABASE_URL: url, DATABASE_ADMIN_URL: url } : { DATABASE_URL: url }
}

/** Declared secrets for a workload; fails loudly on any that was never set. */
export function declaredSecretValues(secrets: SecretMap, w: Workload): Record<string, string> {
  const stored = secrets[w.name] ?? {}
  const values: Record<string, string> = {}
  for (const name of w.secrets) {
    const v = stored[name]
    if (v === undefined) {
      throw new Error(`${w.name}: secret ${name} is declared but not set — \`ee secret set ${w.name} ${name}\``)
    }
    values[name] = v
  }
  return values
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`

/** Each workload that declares `postgres` gets its own database + login (D17). */
async function ensureDatabase(ctx: ReconcileContext, w: Workload): Promise<Record<string, string>> {
  const all = ctx.secrets.all()
  const pgSecrets = all['_postgres'] ?? {}
  let password = pgSecrets[w.name]
  if (!password) {
    password = generateSecret(24)
    await ctx.secrets.set('_postgres', w.name, password)
  }
  const role = w.name.replace(/-/g, '_')
  const superuser = w.tier === 'system'
  const sql = [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${quoteIdent(role)} LOGIN ${superuser ? 'SUPERUSER' : 'NOSUPERUSER NOCREATEDB NOCREATEROLE'} PASSWORD '${password}';
       ELSE
         ALTER ROLE ${quoteIdent(role)} LOGIN ${superuser ? 'SUPERUSER' : 'NOSUPERUSER NOCREATEDB NOCREATEROLE'} PASSWORD '${password}';
       END IF;
     END $$;`,
  ].join('\n')
  await mustRun(ctx.sys, 'runuser', ['-u', 'postgres', '--', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql])
  const exists = await mustRun(ctx.sys, 'runuser', [
    '-u', 'postgres', '--', 'psql', '-tAq', '-c', `SELECT 1 FROM pg_database WHERE datname = '${role}'`,
  ])
  if (exists.trim() !== '1') {
    await mustRun(ctx.sys, 'runuser', ['-u', 'postgres', '--', 'createdb', '-O', role, role])
  }
  {
    // Always, superuser or not: no other role may even connect to this database.
    await mustRun(ctx.sys, 'runuser', [
      '-u', 'postgres', '--', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-c',
      `REVOKE ALL ON DATABASE ${quoteIdent(role)} FROM PUBLIC; GRANT ALL ON DATABASE ${quoteIdent(role)} TO ${quoteIdent(role)};`,
    ])
  }
  return databaseEnv(w, password)
}

async function envFor(ctx: ReconcileContext, w: Workload, contract: AppContract): Promise<Record<string, string>> {
  const values = declaredSecretValues(ctx.secrets.all(), w)
  if (contract.services.includes('postgres')) Object.assign(values, await ensureDatabase(ctx, w))
  return values
}

/**
 * Boot path (ee-env.service): /run is a tmpfs, so env files vanish on reboot.
 * Re-render them for every live slot from the encrypted store before workloads start.
 */
export async function renderLiveEnvFiles(sys: System, desired: DesiredState, journal: Journal, secrets: SecretMap): Promise<number> {
  let n = 0
  for (const w of desired.workloads) {
    const entry = journal.workloads[w.name]
    const live = entry?.active ? entry.slots[entry.active] : undefined
    if (!entry?.active || !live) continue
    const contract = await readContract(sys, `${PATHS.workloads}/${w.name}/releases/${live.release}`, w.name)
    const values = declaredSecretValues(secrets, w)
    if (contract.services.includes('postgres')) {
      const pw = secrets['_postgres']?.[w.name]
      if (!pw) throw new Error(`${w.name}: no database password in the store`)
      Object.assign(values, databaseEnv(w, pw))
    }
    await sys.writeFile(`${PATHS.envDir}/${w.name}-${entry.active}.env`, renderEnvFile(values), 0o600)
    n++
  }
  return n
}

async function waitHealthy(ctx: ReconcileContext, unit: string, port: number, path: string): Promise<string | null> {
  const deadline = ctx.sys.now().getTime() + (ctx.healthTimeoutMs ?? 240_000)
  while (ctx.sys.now().getTime() < deadline) {
    const state = (await ctx.sys.run('systemctl', ['is-active', unit])).stdout.trim()
    if (state === 'failed') return `${unit} failed to start`
    if (state === 'active' && (await ctx.sys.httpOk(port, path, 3000))) return null
    await ctx.sys.sleep(1000)
  }
  return `${unit} did not pass its health check (GET ${path}) in time`
}

async function unitLogs(sys: System, unit: string): Promise<string> {
  return (await sys.run('journalctl', ['-u', unit, '-n', '40', '--no-pager', '-o', 'cat'])).stdout.trim()
}

/** Deploy a node workload: no-op when live, else blue-green to the other slot behind the health gate. */
async function reconcileNode(ctx: ReconcileContext, w: Workload, rel: PreparedRelease): Promise<Upstream | null> {
  const { sys, journal } = ctx
  const entry = workloadEntry(journal, w.name)
  const env = await envFor(ctx, w, rel.contract)
  const groups = w.tier === 'system' && w.name === 'os' ? [CONTROL_GROUP] : []
  const fingerprint = sha(JSON.stringify({ rel: rel.id, w, env, groups }))
  const active = entry.active
  const live = active ? entry.slots[active] : undefined

  if (active && live && live.fingerprint === fingerprint) {
    const state = (await sys.run('systemctl', ['is-active', unitName(w.name, active)])).stdout.trim()
    if (state !== 'active') {
      await mustRun(sys, 'systemctl', ['start', unitName(w.name, active)])
      emit(journal, sys, 'workload.repaired', w.name, `restarted ${unitName(w.name, active)} (was ${state})`)
    }
    return { kind: 'proxy', port: live.port }
  }

  if (entry.failedFingerprint === fingerprint) {
    // Same release + config already failed its health gate: don't flap it every tick.
    // Any change to desired state (new rev, env, secrets) produces a new fingerprint and retries.
    if (live) {
      ctx.deployFailures?.push(`${w.name}: ${entry.lastError ?? 'the last deploy failed'} (unchanged since; the previous release keeps serving)`)
      return { kind: 'proxy', port: live.port }
    }
    throw new Error(`${w.name}: ${entry.lastError ?? 'the last deploy failed'} (unchanged since; fix it and redeploy)`)
  }

  const cand: Slot = active === 'a' ? 'b' : 'a'
  const port = entry.basePort + (cand === 'a' ? 0 : 1)
  const unit = unitName(w.name, cand)
  await sys.writeFile(`${PATHS.envDir}/${w.name}-${cand}.env`, renderEnvFile(env), 0o600)
  const text = renderUnit({ workload: w, contract: rel.contract, slot: cand, port, releaseDir: rel.dir, supplementaryGroups: groups })
  if (groups.length > 0) await sys.mkdirp(PATHS.controlSocketDir, 0o750) // bind target must exist before the unit starts
  await sys.writeFile(`${PATHS.unitDir}/${unit}`, text)
  await mustRun(sys, 'systemctl', ['daemon-reload'])
  await sys.run('systemctl', ['reset-failed', unit])
  // A failing start is not an exception here: the health gate below reports it, with logs.
  await sys.run('systemctl', ['restart', unit])
  emit(journal, sys, 'deploy.started', w.name, `starting ${unit} with release ${rel.id}`, { release: rel.id, slot: cand })

  const failure = await waitHealthy(ctx, unit, port, rel.contract.health)
  if (failure) {
    const logs = await unitLogs(sys, unit)
    await sys.run('systemctl', ['stop', unit])
    entry.lastError = failure
    entry.failedFingerprint = fingerprint
    emit(journal, sys, 'deploy.failed', w.name, `${failure}; ${live ? 'the previous release keeps serving' : 'nothing was live before'}`, {
      release: rel.id,
      logs: logs.slice(-4000),
    })
    if (!live) throw new Error(`${w.name}: ${failure}\n${logs}`)
    ctx.deployFailures?.push(`${w.name}: ${failure}; the previous release keeps serving`)
    return { kind: 'proxy', port: live.port }
  }

  entry.slots[cand] = { release: rel.id, fingerprint, port }
  entry.active = cand
  entry.lastError = null
  entry.failedFingerprint = null
  await mustRun(sys, 'systemctl', ['enable', '--quiet', unit])
  emit(journal, sys, 'deploy.succeeded', w.name, `${unit} is healthy; release ${rel.id} is live`, { release: rel.id, slot: cand })
  return { kind: 'proxy', port }
}

async function retireOldSlot(sys: System, w: string, keep: Slot): Promise<void> {
  const old = unitName(w, keep === 'a' ? 'b' : 'a')
  await sys.run('systemctl', ['disable', '--now', '--quiet', old])
}

export async function reconcile(ctx: ReconcileContext): Promise<DesiredState> {
  const { sys, journal } = ctx
  const desired = await ctx.repo.read()
  const upstreams: Record<string, Upstream> = {}
  const errors: string[] = []
  const failures: string[] = []
  ctx.deployFailures = failures

  for (const w of desired.workloads) {
    try {
      const rel = await prepareRelease(sys, w)
      if (rel.contract.runtime === 'static') {
        const root = `${rel.dir}/${rel.contract.staticDir}`
        const entry = workloadEntry(journal, w.name)
        if (entry.staticRoot !== root) emit(journal, sys, 'deploy.succeeded', w.name, `static release ${rel.id} is live`)
        entry.staticRoot = root
        upstreams[w.name] = { kind: 'static', root }
        continue
      }
      const up = await reconcileNode(ctx, w, rel)
      if (up) upstreams[w.name] = up
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(message)
      const entry = workloadEntry(journal, w.name)
      entry.lastError = message
      emit(journal, sys, 'workload.error', w.name, message)
      const live = entry.active ? entry.slots[entry.active] : undefined
      if (live) upstreams[w.name] = { kind: 'proxy', port: live.port }
      else if (entry.staticRoot) upstreams[w.name] = { kind: 'static', root: entry.staticRoot }
    }
  }

  // Routes whose workload has nothing live are left out — and reported — rather than breaking the edge.
  const routable = desired.routes.filter((r) => {
    if (upstreams[r.workload]) return true
    errors.push(`route ${r.host}: ${r.workload} has nothing live`)
    return false
  })
  const caddy = renderCaddyConfig({
    routes: routable,
    upstreams,
    acmeEmail: desired.settings.acmeEmail,
    internal: [{ port: OS_INTERNAL_PORT, workload: 'os' }],
  })
  const fingerprint = sha(JSON.stringify(caddy))
  if (journal.caddyFingerprint !== fingerprint) {
    await sys.caddyLoad(caddy)
    // Read by Caddy at boot as user caddy; holds only hosts and loopback ports, never secrets.
    await sys.writeFile(PATHS.caddyConfig, JSON.stringify(caddy, null, 2) + '\n', 0o644)
    journal.caddyFingerprint = fingerprint
    emit(journal, sys, 'edge.updated', null, `edge serves ${routable.map((r) => r.host).join(', ') || 'no hosts'}`)
  }

  // Only now — after the edge points at the new slots — drain the old ones.
  for (const w of desired.workloads) {
    const entry = journal.workloads[w.name]
    if (entry?.active) await retireOldSlot(sys, w.name, entry.active)
  }

  // Workloads no longer desired: stop and remove their units.
  const names = new Set(desired.workloads.map((w) => w.name))
  for (const name of Object.keys(journal.workloads)) {
    if (names.has(name)) continue
    for (const slot of ['a', 'b'] as const) {
      await sys.run('systemctl', ['disable', '--now', '--quiet', unitName(name, slot)])
      await sys.remove(`${PATHS.unitDir}/${unitName(name, slot)}`)
    }
    delete journal.workloads[name]
    emit(journal, sys, 'workload.removed', name, `${name} is no longer desired; stopped`)
  }

  journal.appliedRev = desired.rev
  await saveJournal(sys, journal)
  errors.push(...failures)
  if (errors.length > 0) {
    throw new Error(`reconcile finished with errors:\n- ${errors.join('\n- ')}`)
  }
  return desired
}
