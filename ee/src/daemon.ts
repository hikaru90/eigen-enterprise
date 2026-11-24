import { forgetWorkload } from './forget.ts'
import { forgetDeploys, readDeployLog } from './deploys.ts'
import { chmod, chown, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { CompanyRepo, type DesiredState } from './company-repo.ts'
import { loadJournal, saveJournal, type Journal } from './journal.ts'
import { CONTROL_GROUP, PATHS } from './paths.ts'
import { allowRetry, applyEdge, emit, OS_INTERNAL_PORT, reconcile } from './reconcile.ts'
import type { CaddyInput } from './caddy.ts'
import { previewRoute, PreviewService, type PreviewDeps } from './previews.ts'
import { SecretStore } from './secret-store.ts'
import { appContractSchema, assertInCatalog, CATALOG, CatalogGapError, gitSource, NAME, routeSchema, workloadSchema, type Route, type Workload } from './spec.ts'
import { mustRun, type System } from './system.ts'
import { removeDomain, setConsoleHost, setDomain } from './domains.ts'
import { readCertificates, servedHosts } from './certificates.ts'
import { fetchSource, readRepoFile, readTree, SourceReadError, TREE_MAX_DEPTH } from './sources.ts'
import { checkDeployKey, createDeployKey, deleteDeployKey, KEY_ID, REPO } from './deploy-keys.ts'
import { claimState, claimUrl, newClaim, newOwnerLink, OWNER_LINK_SECRETS, ownerLinkUrl } from './claim.ts'
import { BackupService, type BackupDeps } from './backup/service.ts'
import { backupRoute, restoreRoute } from './backup/control.ts'
import { launchRestoreUnit, productionSources, restoreUnitActive, writeBackupTimer } from './backup/box.ts'
import { RestoreService, type RestoreDeps } from './backup/restore.ts'
import { FleetAgent, FleetError } from './fleet/agent.ts'
import { fleetHost } from './fleet/host.ts'
import { readClaims } from './fleet/claims.ts'
import { readHostedAddress } from './fleet/hosted-address.ts'
import { UPGRADE_UNIT as FLEET_UPGRADE_UNIT } from './fleet/agent.ts'
import { fetchReleaseText, hostArch, installedOsRelease } from './upgrade.ts'
import { UPGRADE_UNIT, upgradeRoute, UpgradeService, type UpgradeServiceDeps } from './upgrade-job.ts'
import { boxRollbackDeps, lastUpgradeOutcome } from './rollback-box.ts'
import { RELEASE_PUBLIC_KEY_PEM } from './release-key.ts'
import { ModuleService, moduleRoute, moduleSecretRefusal, type ModuleServiceDeps } from './modules.ts'

/**
 * The control API (§3.1): typed verbs over a unix socket, readable only by root
 * and the ee-control group (granted to the os workload by the install template).
 * There is no "run this" verb; every mutation is validate → commit → reconcile.
 */

export class Ee {
  private queue: Promise<unknown> = Promise.resolve()
  readonly repo: CompanyRepo
  journal!: Journal
  lastReconcileError: string | null = null
  readonly backups: BackupService
  readonly restore: RestoreService
  /** Managed mode (fleet/agent.ts); polls only once enrolled. */
  readonly fleet: FleetAgent
  /** Settings → Updates (upgrade-job.ts). */
  readonly upgrades: UpgradeService
  /** Drive app previews (previews.ts): in memory only, wiped on every start. */
  readonly previews: PreviewService
  /** Module workloads (modules.ts, plan/phase-upgrades-u2.md §5). */
  readonly modules: ModuleService
  /** The edge as the last reconcile rendered it from desired state (previews are added on load). */
  private edgeBase: CaddyInput | null = null
  private edgeQueue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly sys: System,
    readonly secrets: SecretStore,
    backupDeps: Partial<BackupDeps> = {},
    restoreDeps: Partial<RestoreDeps> = {},
    upgradeDeps: Partial<UpgradeServiceDeps> = {},
    previewDeps: Partial<PreviewDeps> = {},
    moduleDeps: Partial<ModuleServiceDeps> = {},
  ) {
    this.repo = new CompanyRepo(sys, PATHS.company)
    this.backups = new BackupService({
      secrets,
      readFile: (p) => sys.readFile(p),
      writeFile: (p, c, m) => sys.writeFile(p, c, m),
      runsFile: PATHS.backupRuns,
      sources: productionSources(),
      now: () => sys.now(),
      emit: async (type, message, data) => {
        emit(this.journal, sys, type, null, message, data)
        await saveJournal(sys, this.journal)
      },
      applySchedule: (s) => writeBackupTimer(sys, s),
      // A check or restore of a backup holds the one job slot.
      busy: () => this.restore.busyNow(),
      ...backupDeps,
    })
    this.restore = new RestoreService({
      backups: this.backups,
      readFile: (p) => sys.readFile(p),
      writeFile: (p, c, m) => sys.writeFile(p, c, m),
      stateFile: PATHS.restoreState,
      stagingDir: PATHS.backupTmp,
      now: () => sys.now(),
      emit: async (type, message, data) => {
        emit(this.journal, sys, type, null, message, data)
        await saveJournal(sys, this.journal)
      },
      launchApply: (id) => launchRestoreUnit(sys, id),
      applyActive: () => restoreUnitActive(sys),
      ...restoreDeps,
    })
    this.fleet = new FleetAgent(fleetHost(this))
    const unitActive = async (unit: string) => (await sys.run('systemctl', ['is-active', '--quiet', unit])).code === 0
    this.upgrades = new UpgradeService({
      readFile: (p) => sys.readFile(p),
      writeFile: (p, c, m) => sys.writeFile(p, c, m),
      stateFile: PATHS.upgradeState,
      now: () => sys.now(),
      emit: async (type, message, data) => {
        emit(this.journal, sys, type, 'os', message, data)
        await saveJournal(sys, this.journal)
      },
      settings: async () => {
        const { settings } = await this.repo.read()
        return { managed: settings.managed !== null, releaseSource: settings.releaseSource }
      },
      installed: () => installedOsRelease(sys, this.repo),
      arch: hostArch(),
      fetchText: fetchReleaseText,
      releaseKeyPem: RELEASE_PUBLIC_KEY_PEM,
      // Detached: the installer restarts ee.service and redeploys os; the update must outlive both.
      launch: async (id) =>
        void (await mustRun(sys, 'systemd-run', [
          `--unit=${UPGRADE_UNIT}`,
          '--description=eigenEnterprise update (Settings → Updates)',
          '--collect',
          '--quiet',
          '--property=Type=exec',
          '/usr/local/bin/ee',
          'upgrade-apply',
          '--job',
          id,
        ])),
      unitActive: () => unitActive(UPGRADE_UNIT),
      otherBusy: async () => {
        if (await unitActive(`${FLEET_UPGRADE_UNIT}.service`)) return 'the hosting provider is updating this server; wait for it to finish'
        return this.restore.busy()
      },
      // U3: the upgrade report and `ee rollback` (rollback-box.ts).
      lastOutcome: async () => lastUpgradeOutcome(this.journal),
      rollback: boxRollbackDeps(
        {
          sys,
          repo: this.repo,
          journal: () => this.journal,
          change: (message, author, mutate) => this.change(message, author, mutate),
          restoreBusy: () => this.restore.busy(),
        },
        hostArch(),
      ),
      ...upgradeDeps,
    })
    this.previews = new PreviewService({
      sys,
      consoleHost: async () => (await this.repo.read()).settings.consoleHost,
      emit: async (type, message, data) => {
        emit(this.journal, sys, type, null, message, data)
        await saveJournal(sys, this.journal)
      },
      edgeChanged: () => this.previewsChanged(),
      ...previewDeps,
    })
    this.modules = new ModuleService({
      sys,
      repo: this.repo,
      secrets,
      journal: () => this.journal,
      emit: async (type, workload, message, data) => {
        emit(this.journal, sys, type, workload, message, data)
        await saveJournal(sys, this.journal)
      },
      change: (message, author, mutate) => this.change(message, author, mutate),
      exclusive: (fn) => this.exclusive(fn),
      ...moduleDeps,
    })
  }

  /**
   * Load the edge: desired state's routes plus the active previews, one load at a
   * time so an older render never lands after a newer one.
   */
  private loadEdge(base: CaddyInput): Promise<void> {
    this.edgeBase = base
    const next = this.edgeQueue.then(() => applyEdge(this.sys, this.journal, { ...base, previews: this.previews.routes() }))
    this.edgeQueue = next.catch(() => undefined)
    return next
  }

  /** A preview started, came up or stopped: re-render the edge without a full reconcile. */
  async previewsChanged(): Promise<void> {
    if (!this.edgeBase) {
      // Nothing rendered by this process yet: a reconcile renders the edge (previews included).
      // Its own workload errors are not the preview's; only a missing edge is.
      await this.reconcile().catch(() => undefined)
      if (!this.edgeBase) throw new Error(`the edge was not rendered: ${this.lastReconcileError ?? 'reconcile did not reach Caddy'}`)
      return
    }
    await this.loadEdge(this.edgeBase)
    await saveJournal(this.sys, this.journal)
  }

  async load(): Promise<void> {
    this.journal = await loadJournal(this.sys)
    // Settle a check/restore cut off by a restart, and journal a restore the unit finished.
    await this.restore.job()
    // The same for an update from Settings → Updates (its unit restarts ee mid-way).
    await this.upgrades.job()
  }

  /** Serialize every mutation and reconcile; ee never runs two at once. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  reconcile(): Promise<DesiredState> {
    return this.exclusive(async () => {
      try {
        const d = await reconcile({ sys: this.sys, repo: this.repo, journal: this.journal, secrets: this.secrets, edge: (input) => this.loadEdge(input) })
        this.lastReconcileError = null
        return d
      } catch (err) {
        this.lastReconcileError = err instanceof Error ? err.message : String(err)
        await saveJournal(this.sys, this.journal)
        throw err
      }
    })
  }

  /** Commit a desired-state change, then converge to it. */
  async change(
    message: string,
    author: string,
    mutate: Parameters<CompanyRepo['commit']>[2],
  ): Promise<{ rev: string; reconcileError: string | null }> {
    const rev = await this.exclusive(() => this.repo.commit(message, author, mutate))
    emit(this.journal, this.sys, 'state.committed', null, message, { rev, author })
    try {
      await this.reconcile()
      return { rev, reconcileError: null }
    } catch (err) {
      return { rev, reconcileError: err instanceof Error ? err.message : String(err) }
    }
  }

  async status() {
    const desired = await this.repo.read()
    return {
      appliedRev: this.journal.appliedRev,
      desiredRev: desired.rev,
      lastReconcileError: this.lastReconcileError,
      settings: desired.settings,
      routes: desired.routes,
      workloads: desired.workloads.map((w) => {
        const j = this.journal.workloads[w.name]
        const live = j?.active ? j.slots[j.active] : undefined
        return {
          name: w.name,
          tier: w.tier,
          source: w.source.kind === 'git' ? { kind: 'git', mirror: w.source.mirror, ref: w.source.ref, rev: w.source.rev } : { kind: 'release' },
          deploy: w.deploy,
          contract: w.contract ?? null,
          secrets: Object.keys(this.secrets.all()[w.name] ?? {}),
          declaredSecrets: w.secrets,
          live: live ? { release: live.release, slot: j?.active } : j?.staticRoot ? { release: 'static' } : null,
          lastError: j?.lastError ?? null,
        }
      }),
      events: this.journal.events.slice(-50),
      backups: await this.backups.status(),
      certificates: await readCertificates(this.sys, servedHosts(desired.settings, desired.routes)),
      /** Managed box: the domain claims the control plane last sent (fleet/claims.ts); null = not managed / nothing received yet. */
      claims: desired.settings.managed ? await readClaims(this.sys, PATHS.fleetClaims) : null,
      /**
       * Managed box: the company's free hosted address `{ mailDomain, siteHost }` the control plane last sent
       * (plan/hosted-address.md H5, fleet/hosted-address.ts); null = not managed / none (adopted, or nothing received yet).
       */
      hostedAddress: desired.settings.managed ? (await readHostedAddress(this.sys, PATHS.fleetHostedAddress)).hostedAddress : null,
    }
  }

  /**
   * Make Caddy try a host's certificate now: a graceful forced reload of the
   * edge config it already runs (`systemctl reload caddy` → `caddy reload --force`)
   * restarts certificate management and so ends an ACME backoff. Serving continues.
   */
  async retryCertificate(host: string, author: string): Promise<{ host: string; reloaded: true }> {
    const desired = await this.repo.read()
    if (!servedHosts(desired.settings, desired.routes).includes(host)) {
      throw new HttpError(404, `this server does not serve ${host}, so it has no certificate to retry; set the domain first`)
    }
    const next = this.edgeQueue.then(() => mustRun(this.sys, 'systemctl', ['reload', 'caddy.service']))
    this.edgeQueue = next.catch(() => undefined)
    await next
    emit(this.journal, this.sys, 'certificate.retry', null, `certificate for ${host}: Caddy reloaded to retry now (by ${author})`, { host })
    await saveJournal(this.sys, this.journal)
    return { host, reloaded: true }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function sourceRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (err instanceof SourceReadError) throw new HttpError(err.status, err.message)
    throw err
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of req) {
    raw += String(chunk)
    if (raw.length > 1_000_000) throw new HttpError(413, 'body too large')
  }
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const text = JSON.stringify(data)
  res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' })
  res.end(text)
}

const author = z.string().min(1).max(64)
const domainInput = z.object({ host: routeSchema.shape.host, workload: z.string().regex(NAME), role: z.enum(['console', 'public', 'app']), author }).strict()
const secretInput = z.object({ workload: z.string().regex(/^[a-z_][a-z0-9_-]{1,30}$/), name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), value: z.string().min(1).max(16384), author }).strict()
const appInput = z
  .object({
    name: z.string().regex(NAME),
    source: gitSource,
    env: workloadSchema.shape.env,
    secrets: workloadSchema.shape.secrets,
    deploy: workloadSchema.shape.deploy,
    /** The owner's build contract when the repo has no ee.json (stored in the company repo). */
    contract: appContractSchema.optional(),
    author,
  })
  .strict()
const deployInput = z.object({ workload: z.string().regex(NAME), rev: z.string().regex(/^[0-9a-f]{40}$/), author }).strict()
const fetchInput = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    url: z.string().min(1).max(400),
    ref: z.string().min(1).max(200),
    /** Short-lived token used for this fetch only; never persisted by ee. */
    token: z.string().min(1).max(4096).optional(),
    /** A deploy key ee holds (POST /v1/deploy-keys); the url is then git@github.com:owner/repo.git. */
    deployKeyId: z.string().regex(KEY_ID).optional(),
  })
  .strict()
const deployKeyCreate = z.object({ repo: z.string().regex(REPO), author }).strict()
const deployKeyCheck = z.object({ repo: z.string().regex(REPO) }).strict()
const deployKeyDelete = z.object({ author }).strict()
const DEPLOY_LOG_PATH = /^\/v1\/deploys\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/log$/
const MAX_FILES = 500
const DEPLOY_KEY_PATH =/^\/v1\/deploy-keys\/(dk_[a-f0-9]{24})(\/check)?$/

/** The control API's request handler (exported so the verbs are testable over a real socket). */
export function controlHandler(ee: Ee): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://ee')
      const route = `${req.method} ${url.pathname}`
      if (route === 'GET /v1/status') return send(res, 200, await ee.status())
      if (url.pathname.startsWith('/v1/backups')) {
        const b = (await restoreRoute(ee.restore, route, () => body(req))) ?? (await backupRoute(ee.backups, route, () => body(req)))
        if (b) return send(res, b.status, b.data)
      }
      if (url.pathname.startsWith('/v1/previews')) {
        const p = await previewRoute(ee.previews, route, () => body(req))
        if (p) return send(res, p.status, p.data)
      }
      if (url.pathname.startsWith('/v1/modules')) {
        const m = await moduleRoute(ee.modules, route, url.searchParams, () => body(req))
        if (m) return send(res, m.status, m.data)
      }
      if (url.pathname.startsWith('/v1/upgrade')) {
        const u = await upgradeRoute(ee.upgrades, route, () => body(req))
        if (u) return send(res, u.status, u.data)
      }
      if (route === 'POST /v1/managed/enroll') {
        // The token is a one-time secret: it goes to the control plane only, never into a log or the journal.
        const i = z.object({ controlPlane: z.string().min(1).max(400), token: z.string().min(1).max(256), author }).strict().parse(await body(req))
        try {
          return send(res, 200, { managed: await ee.fleet.enroll({ controlPlane: i.controlPlane, token: i.token }) })
        } catch (err) {
          if (err instanceof FleetError) throw new HttpError(err.status, err.message)
          throw err
        }
      }
      if (route === 'GET /v1/managed') {
        const { settings } = await ee.repo.read()
        return send(res, 200, { managed: settings.managed, suspended: settings.suspended, lastPoll: ee.fleet.lastPoll })
      }
      if (route === 'POST /v1/reconcile') {
        try {
          await ee.reconcile()
          return send(res, 200, { ok: true })
        } catch (err) {
          return send(res, 500, { type: 'urn:ee:reconcile_failed', title: 'reconcile failed', detail: (err as Error).message })
        }
      }
      if (route === 'POST /v1/domains') {
        const i = domainInput.parse(await body(req))
        let replaced: string | null = null
        const result = await ee.change(`domain: ${i.host} → ${i.workload} (${i.role})`, i.author, (s) => {
          const out = setDomain(s, i)
          replaced = out.replaced
          return out.state
        })
        if (replaced !== null) {
          emit(ee.journal, ee.sys, 'domain.replaced', i.workload, `${i.host} now shows ${i.workload} instead of ${replaced} (set by ${i.author})`, {
            host: i.host,
            previous: replaced,
            next: i.workload,
          })
          await saveJournal(ee.sys, ee.journal)
        }
        return send(res, 200, { ...result, replaced })
      }
      if (route === 'POST /v1/certificates/retry') {
        const i = z.object({ host: routeSchema.shape.host, author }).strict().parse(await body(req))
        return send(res, 200, await ee.retryCertificate(i.host, i.author))
      }
      if (route === 'DELETE /v1/domains') {
        const i = z.object({ host: z.string(), author }).strict().parse(await body(req))
        return send(res, 200, await ee.change(`domain: remove ${i.host}`, i.author, (s) => removeDomain(s, i.host)))
      }
      if (route === 'POST /v1/console-host') {
        const i = z.object({ host: routeSchema.shape.host, author }).strict().parse(await body(req))
        return send(res, 200, await ee.change(`console host: ${i.host}`, i.author, (s) => setConsoleHost(s, i.host)))
      }
      if (route === 'POST /v1/secrets') {
        const i = secretInput.parse(await body(req))
        if (i.workload.startsWith('_')) throw new HttpError(403, 'internal secret scopes are not settable')
        const desired = await ee.repo.read()
        const target = desired.workloads.find((w) => w.name === i.workload)
        if (!target) throw new HttpError(404, `no workload ${i.workload}`)
        // A module gets only the secrets its receipted manifest declares (modules.ts).
        const undeclared = moduleSecretRefusal(target, i.name)
        if (undeclared) return send(res, 403, undeclared)
        await ee.exclusive(() => ee.secrets.set(i.workload, i.name, i.value))
        emit(ee.journal, ee.sys, 'secret.set', i.workload, `secret ${i.name} set by ${i.author}`)
        // Setting a secret declares it: the workload gets it on its next (health-gated) deploy.
        if (!target.secrets.includes(i.name)) {
          const r = await ee.change(`secret: ${i.workload} declares ${i.name}`, i.author, (s) => ({
            ...s,
            workloads: s.workloads.map((w) => (w.name === i.workload ? { ...w, secrets: [...w.secrets, i.name] } : w)),
          }))
          return send(res, 200, { ok: true, reconcileError: r.reconcileError })
        }
        try {
          await ee.reconcile()
          return send(res, 200, { ok: true, reconcileError: null })
        } catch (err) {
          return send(res, 200, { ok: true, reconcileError: (err as Error).message })
        }
      }
      if (route === 'POST /v1/claim') {
        // A fresh claim link (lost or expired). Only the hash + expiry are stored;
        // the token goes back once, to the caller (root on the box, via `ee claim-link`).
        const i = z.object({ author }).strict().parse(await body(req))
        // Only while the company has no owner: eigenEnterprise is asked (its database is the truth).
        const state = await claimState(ee.sys, OS_INTERNAL_PORT)
        if (state === 'claimed') throw new HttpError(409, 'this company already has an owner; claim links are only for a server nobody has claimed yet')
        if (state === 'unreachable') throw new HttpError(503, 'eigenEnterprise is not answering, so ee cannot tell whether the company is claimed; no claim link minted')
        const claim = newClaim()
        await ee.exclusive(async () => {
          await ee.secrets.set('os', 'EE_CLAIM_TOKEN_HASH', claim.hash)
          await ee.secrets.set('os', 'EE_CLAIM_EXPIRES_AT', claim.expiresAt)
        })
        emit(ee.journal, ee.sys, 'claim.issued', 'os', `new claim link issued by ${i.author} (expires ${claim.expiresAt})`)
        const desired = await ee.repo.read()
        let reconcileError: string | null = null
        try {
          await ee.reconcile()
        } catch (err) {
          reconcileError = (err as Error).message
        }
        return send(res, 200, { url: claimUrl(desired.settings.consoleHost, claim.token), expiresAt: claim.expiresAt, reconcileError })
      }
      if (route === 'POST /v1/owner-link') {
        // Back in as the owner (no passkey, no company email yet): a one-hour, single-use link. Like a
        // claim link, only the hash + expiry are stored and the token goes back once, to root on the box.
        const i = z.object({ author }).strict().parse(await body(req))
        const state = await claimState(ee.sys, OS_INTERNAL_PORT)
        if (state === 'open') throw new HttpError(409, 'nobody owns this company yet; run `ee claim-link` to claim it')
        if (state === 'unreachable') throw new HttpError(503, 'eigenEnterprise is not answering, so ee cannot tell whether the company has an owner; no owner link minted')
        const link = newOwnerLink()
        await ee.exclusive(async () => {
          await ee.secrets.set('os', 'EE_OWNER_LINK_HASH', link.hash)
          await ee.secrets.set('os', 'EE_OWNER_LINK_EXPIRES_AT', link.expiresAt)
        })
        emit(ee.journal, ee.sys, 'owner_link.issued', 'os', `owner sign-in link issued by ${i.author} (expires ${link.expiresAt})`)
        const desired = await ee.repo.read()
        const os = desired.workloads.find((w) => w.name === 'os')
        if (!os) throw new HttpError(404, 'no workload os')
        const missing = OWNER_LINK_SECRETS.filter((n) => !os.secrets.includes(n))
        let reconcileError: string | null = null
        if (missing.length > 0) {
          // First link on this box: declaring the two secrets redeploys os with them (health-gated).
          reconcileError = (
            await ee.change(`secret: os declares ${missing.join(', ')}`, i.author, (s) => ({
              ...s,
              workloads: s.workloads.map((w) => (w.name === 'os' ? { ...w, secrets: [...w.secrets, ...missing] } : w)),
            }))
          ).reconcileError
        } else {
          try {
            await ee.reconcile()
          } catch (err) {
            reconcileError = (err as Error).message
          }
        }
        return send(res, 200, { url: ownerLinkUrl(desired.settings.consoleHost, link.token), expiresAt: link.expiresAt, reconcileError })
      }
      if (route === 'POST /v1/sources/fetch') {
        const i = fetchInput.parse(await body(req))
        const rev = await ee.exclusive(() => fetchSource(ee.sys, i, ee.secrets))
        return send(res, 200, { mirror: `sources/${i.name}.git`, ref: i.ref, rev })
      }
      if (route === 'POST /v1/deploy-keys') {
        // Generates a read-only deploy key for one repo; only the public half leaves ee.
        const i = deployKeyCreate.parse(await body(req))
        const out = await ee.exclusive(() => createDeployKey(ee.sys, ee.secrets, { repo: i.repo }))
        emit(ee.journal, ee.sys, 'deploy_key.created', null, `deploy key ${out.keyId} for ${i.repo} created by ${i.author}`)
        return send(res, 200, out)
      }
      const dk = DEPLOY_KEY_PATH.exec(url.pathname)
      if (dk && req.method === 'POST' && dk[2]) {
        const i = deployKeyCheck.parse(await body(req))
        return send(res, 200, await ee.exclusive(() => checkDeployKey(ee.sys, ee.secrets, dk[1]!, i)))
      }
      if (dk && req.method === 'DELETE' && !dk[2]) {
        const i = deployKeyDelete.parse(await body(req))
        try {
          await ee.exclusive(() => deleteDeployKey(ee.secrets, dk[1]!))
        } catch (err) {
          throw new HttpError(404, (err as Error).message)
        }
        emit(ee.journal, ee.sys, 'deploy_key.deleted', null, `deploy key ${dk[1]} deleted by ${i.author}`)
        return send(res, 200, { ok: true })
      }
      if (route === 'GET /v1/catalog') return send(res, 200, CATALOG)
      if (route === 'GET /v1/sources/contract') {
        // The repo's own ee.json at a pinned rev, read from the local mirror (never the network).
        const name = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).parse(url.searchParams.get('name'))
        const rev = z.string().regex(/^[0-9a-f]{40}$/).parse(url.searchParams.get('rev'))
        const mirror = `${PATHS.company}/sources/${name}.git`
        if (!(await ee.sys.exists(mirror))) throw new HttpError(404, `no mirror ${name}`)
        const listed = await mustRun(ee.sys, 'git', ['-C', mirror, 'ls-tree', '--name-only', rev, '--', 'ee.json'])
        if (listed.trim() !== 'ee.json') return send(res, 200, { present: false, contract: null, gap: null, error: null })
        const raw = await mustRun(ee.sys, 'git', ['-C', mirror, 'show', `${rev}:ee.json`])
        let json: unknown
        try {
          json = JSON.parse(raw)
        } catch {
          return send(res, 200, { present: true, contract: null, gap: null, error: 'ee.json is not valid JSON' })
        }
        const parsed = appContractSchema.safeParse(json)
        if (!parsed.success) return send(res, 200, { present: true, contract: null, gap: null, error: `ee.json is invalid: ${parsed.error.message}` })
        try {
          assertInCatalog(parsed.data, 'app')
        } catch (err) {
          if (err instanceof CatalogGapError) return send(res, 200, { present: true, contract: parsed.data, gap: err.missing, error: null })
          throw err
        }
        return send(res, 200, { present: true, contract: parsed.data, gap: null, error: null })
      }
      if (route === 'GET /v1/sources/tree') {
        const name = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).parse(url.searchParams.get('name'))
        const rev = z.string().regex(/^[0-9a-f]{40}$/).parse(url.searchParams.get('rev'))
        const depth = z.coerce.number().int().min(1).max(TREE_MAX_DEPTH).parse(url.searchParams.get('depth') ?? '1')
        return send(res, 200, await sourceRead(() => readTree(ee.sys, name, rev, depth)))
      }
      if (route === 'GET /v1/sources/file') {
        const name = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).parse(url.searchParams.get('name'))
        const rev = z.string().regex(/^[0-9a-f]{40}$/).parse(url.searchParams.get('rev'))
        const path = z.string().parse(url.searchParams.get('path'))
        return send(res, 200, await sourceRead(() => readRepoFile(ee.sys, name, rev, path)))
      }
      if (route === 'GET /v1/events') {
        const name = z.string().regex(NAME).parse(url.searchParams.get('workload'))
        return send(res, 200, { workload: name, events: ee.journal.events.filter((e) => e.workload === name).slice(-100) })
      }
      if (route === 'GET /v1/deploys') {
        const name = z.string().regex(NAME).parse(url.searchParams.get('workload'))
        const deploys = ee.journal.deploys.filter((d) => d.workload === name).reverse()
        return send(res, 200, { workload: name, deploys })
      }
      const dl = DEPLOY_LOG_PATH.exec(url.pathname)
      if (dl && req.method === 'GET') {
        const deploy = ee.journal.deploys.find((d) => d.id === dl[1])
        if (!deploy) throw new HttpError(404, `no deploy ${dl[1]}`)
        return send(res, 200, { deploy, lines: await readDeployLog(ee.sys, deploy.id) })
      }
      if (route === 'GET /v1/sources/files') {
        // The tree at a pinned rev (names only), so the agent can tell a wrong start path from a crash.
        const name = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).parse(url.searchParams.get('name'))
        const rev = z.string().regex(/^[0-9a-f]{40}$/).parse(url.searchParams.get('rev'))
        const mirror = `${PATHS.company}/sources/${name}.git`
        if (!(await ee.sys.exists(mirror))) throw new HttpError(404, `no mirror ${name}`)
        const out = await mustRun(ee.sys, 'git', ['-C', mirror, 'ls-tree', '-r', '--name-only', rev])
        const all = out.split('\n').filter(Boolean)
        return send(res, 200, { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES })
      }
      if (route === 'POST /v1/apps') {
        const i = appInput.parse(await body(req))
        if (i.contract) {
          try {
            assertInCatalog(i.contract, 'app')
          } catch (err) {
            if (err instanceof CatalogGapError) {
              return send(res, 422, { type: 'urn:ee:catalog_gap', title: 'catalog gap', detail: err.message, missing: err.missing })
            }
            throw err
          }
        }
        return send(
          res,
          200,
          await ee.change(`app: ${i.name} @ ${i.source.rev.slice(0, 12)}`, i.author, (s) => {
            const existing = s.workloads.find((w) => w.name === i.name)
            if (existing && existing.tier !== 'app') throw new HttpError(403, `${i.name} is a ${existing.tier} workload`)
            // Re-creating an app keeps the secrets it already declared (values live in the store).
            const secrets = [...new Set([...(existing?.secrets ?? []), ...i.secrets])]
            const next: Workload = workloadSchema.parse({ name: i.name, tier: 'app', source: i.source, env: i.env, secrets, deploy: i.deploy, ...(i.contract ? { contract: i.contract } : {}) })
            // The owner asked for this deploy: a release that failed before is tried again.
            allowRetry(ee.journal, i.name)
            return { ...s, workloads: [...s.workloads.filter((w) => w.name !== i.name), next] }
          }),
        )
      }
      if (route === 'POST /v1/deploy') {
        const i = deployInput.parse(await body(req))
        return send(
          res,
          200,
          await ee.change(`deploy: ${i.workload} @ ${i.rev.slice(0, 12)}`, i.author, (s) => ({
            ...s,
            workloads: s.workloads.map((w) => {
              if (w.name !== i.workload) return w
              if (w.source.kind !== 'git') throw new HttpError(409, `${w.name} is not a git workload`)
              allowRetry(ee.journal, w.name)
              return { ...w, source: { ...w.source, rev: i.rev } }
            }),
          })),
        )
      }
      if (route === 'DELETE /v1/apps') {
        const i = z.object({ name: z.string().regex(NAME), author }).strict().parse(await body(req))
        const result = await ee.change(`app: remove ${i.name}`, i.author, (s) => {
            const w = s.workloads.find((x) => x.name === i.name)
            if (!w) throw new HttpError(404, `no workload ${i.name}`)
            if (w.tier !== 'app') throw new HttpError(403, `${i.name} is a ${w.tier} workload`)
            return { ...s, workloads: s.workloads.filter((x) => x.name !== i.name), routes: s.routes.filter((r: Route) => r.workload !== i.name) }
          })
        // Gone from the desired state: forget its secrets and history too.
        await forgetDeploys(ee.sys, ee.journal, i.name)
        await forgetWorkload({ journal: ee.journal, secrets: ee.secrets, name: i.name, author: i.author })
        await saveJournal(ee.sys, ee.journal)
        return send(res, 200, result)
      }
      if (route === 'GET /v1/logs') {
        const name = z.string().regex(NAME).parse(url.searchParams.get('workload'))
        const j = ee.journal.workloads[name]
        if (!j?.active) throw new HttpError(404, `${name} has nothing live`)
        const out = await mustRun(ee.sys, 'journalctl', ['-u', `ee-${name}-${j.active}.service`, '-n', '200', '--no-pager', '-o', 'short-iso'])
        return send(res, 200, { workload: name, lines: out.split('\n') })
      }
      throw new HttpError(404, `no such verb: ${route}`)
    } catch (err) {
      if (err instanceof z.ZodError) return send(res, 400, { type: 'urn:ee:invalid_input', title: 'invalid input', detail: err.message })
      if (err instanceof HttpError) return send(res, err.status, { type: 'urn:ee:error', title: err.message, detail: err.message })
      return send(res, 500, { type: 'urn:ee:internal', title: 'internal error', detail: (err as Error).message })
    }
  }
}

export function startControlServer(ee: Ee): Promise<void> {
  const server = createServer(controlHandler(ee))

  return (async () => {
    await ee.sys.mkdirp(PATHS.controlSocketDir, 0o750)
    await rm(PATHS.controlSocket, { force: true })
    await new Promise<void>((resolve) => server.listen(PATHS.controlSocket, resolve))
    const gid = Number((await mustRun(ee.sys, 'getent', ['group', CONTROL_GROUP])).split(':')[2])
    await chown(PATHS.controlSocketDir, 0, gid)
    await chown(PATHS.controlSocket, 0, gid)
    await chmod(PATHS.controlSocketDir, 0o750)
    await chmod(PATHS.controlSocket, 0o660)
  })()
}
