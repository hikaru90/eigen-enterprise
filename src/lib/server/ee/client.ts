import { request } from 'node:http'
import {
  deployModuleRequestSchema,
  dryRunAnswerSchema,
  MODULE_PROBLEM_TYPES,
  moduleAnswerSchema,
  moduleIdParam,
  moduleListAnswerSchema,
  moduleLogsAnswerSchema,
  moduleLogsQuerySchema,
  removeModuleRequestSchema,
  startModuleRequestSchema,
  stopModuleRequestSchema,
  type DeployModuleRequest,
  type DryRunAnswer,
  type ModuleView,
  type RemoveModuleRequest,
  type StartModuleRequest,
  type StopModuleRequest,
} from '../../../../contracts/module-workload'

/** ee's AppContract (ee/src/spec.ts), as it travels over the control API. */
export type AppContract = {
  runtime: 'node' | 'static'
  node?: string
  build: string[][]
  start?: string[]
  preStart: string[][]
  staticDir?: string
  health: string
  portEnv?: string
  services: string[]
  capabilities: string[]
}

/** What eigen provides (ee's CATALOG, D16). */
export type Catalog = {
  runtimes: { node: string[]; static: string[] }
  services: string[]
  capabilities: string[]
}

/** ee's answer for the repo's own ee.json at a pinned rev. */
export type RepoContract = {
  present: boolean
  contract: AppContract | null
  /** Catalog entries the ee.json needs and eigen lacks. */
  gap: string[] | null
  error: string | null
}

/** ee's bounded listing of a mirror at a rev (GET /v1/sources/tree). */
export type SourceTree = {
  entries: Array<{ path: string; type: 'blob' | 'tree'; size: number | null }>
  truncated: boolean
}

/** One text file from a mirror at a rev (GET /v1/sources/file). */
export type SourceFile = { path: string; size: number; content: string }

/**
 * Client for ee's control API (ee/src/daemon.ts) over its unix socket. The
 * socket only exists on a box ee manages; anywhere else every call fails with
 * an explicit SubstrateUnavailableError — never a silent no-op.
 */

export const EE_CONTROL_SOCKET = '/run/ee/control/ee.sock'

export class SubstrateUnavailableError extends Error {
  readonly code = 'substrate_unavailable'
  constructor(detail: string) {
    super(`this eigenEnterprise is not running under ee (${EE_CONTROL_SOCKET}: ${detail})`)
  }
}

export class SubstrateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** ee's problem type (e.g. urn:ee:catalog_gap) and body, for structured handling. */
    readonly type: string | null = null,
    readonly body: unknown = null,
  ) {
    super(message)
  }
}

export type EeTransport = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; data: unknown }>

/**
 * The control socket ee serves. EE_CONTROL_SOCKET points the app at another
 * ee (the browser e2e harness runs its own on a temp socket); unset, it is
 * the one path ee uses on every box.
 */
export function controlSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.EE_CONTROL_SOCKET?.trim() || EE_CONTROL_SOCKET
}

export const socketTransport =
  (socketPath = controlSocketPath()): EeTransport =>
  (method, path, body) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path,
          method,
          timeout: 15 * 60_000, // a deploy waits for the health gate
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(text),
          },
        },
        (res) => {
          let raw = ''
          res.on('data', (d) => (raw += String(d)))
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 500, data: raw ? JSON.parse(raw) : null })
            } catch {
              reject(new SubstrateError(502, `ee answered with non-JSON: ${raw.slice(0, 200)}`))
            }
          })
        },
      )
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
          reject(new SubstrateUnavailableError(err.code))
        } else reject(err)
      })
      req.end(text)
    })
  }

export type EeStatus = {
  appliedRev: string | null
  desiredRev: string
  lastReconcileError: string | null
  settings: {
    consoleHost: string
    publicHost: string | null
    acmeEmail: string | null
    /** rtc.<console host> → livekit while calls run; null otherwise (ee/src/domains.ts). */
    callsHost: string | null
  }
  routes: Array<{ host: string; workload: string; allowPaths?: string[] }>
  /** One per host ee serves (console, calls, every route), observed from Caddy (ee/src/certificates.ts). */
  certificates: EeCertificate[]
  /** Managed box: every domain claim the company holds at the control plane, with its TXT; null = not managed / nothing received yet (ee/src/fleet/claims.ts). */
  claims: EeClaim[] | null
  workloads: Array<{
    name: string
    tier: 'system' | 'module' | 'app'
    source: { kind: 'release' } | { kind: 'git'; mirror: string; ref: string; rev: string }
    deploy: { auto: boolean }
    /** The owner's build contract stored in the company repo (null: the repo's ee.json). */
    contract: AppContract | null
    secrets: string[]
    declaredSecrets: string[]
    live: { release: string; slot?: string } | null
    lastError: string | null
  }>
  events: Array<{
    id: string
    time: string
    type: string
    workload: string | null
    message: string
  }>
}

export type EeEvent = {
  id: string
  time: string
  type: string
  workload: string | null
  message: string
  data: Record<string, unknown>
}

export type EeDeployStage = 'fetching' | 'building' | 'starting' | 'health' | 'live' | 'failed'

/** ee's record of one deploy attempt (ee/src/deploys.ts). */
export type EeDeploy = {
  id: string
  workload: string
  release: string | null
  status: 'running' | 'live' | 'failed'
  stage: EeDeployStage
  stages: Array<{ stage: EeDeployStage; at: string }>
  startedAt: string
  endedAt: string | null
  /** The plain one-line cause ee recorded. */
  error: string | null
}

export type ChangeResult = { rev: string; reconcileError: string | null }

/** POST /v1/domains: the change, plus the workload the host showed before (null: it showed nothing else). */
export type DomainSetResult = ChangeResult & { replaced: string | null }

/**
 * A host's certificate as ee observes it: issued (a valid one is stored), failing
 * (no valid one; Caddy's last attempt failed), pending (no valid one yet, no failure
 * seen). lastError is Caddy's own text; nextRetryAt null = not known or not waiting.
 */
export type EeCertificate = {
  host: string
  state: 'issued' | 'pending' | 'failing'
  lastError: string | null
  nextRetryAt: string | null
  notAfter: string | null
}

/** A custom host is routed on a managed box only once `txtName` (`_ee-verify.<host>`) holds `txtValue` (fleet protocol `desired.claims`). */
export type EeClaim = {
  host: string
  verified: boolean
  txtName: string
  txtValue: string
}

/** An S3-compatible bucket (ee/src/backup/s3.ts). */
export type BackupTarget = {
  endpoint: string
  region: string
  bucket: string
  prefix: string
  addressing: 'path' | 'virtual'
  accessKeyId: string
  secretAccessKey: string
}

/** One backup run as ee records it (ee/src/backup/service.ts). */
export type BackupRun = {
  id: string
  trigger: 'scheduled' | 'manual'
  author: string
  status: 'running' | 'succeeded' | 'failed'
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  snapshotId: string | null
  bytesUploaded: number | null
  snapshotSize: number | null
  blobsUploaded: number | null
  blobsTotal: number | null
  pruned: { snapshots: number; blobs: number } | null
  error: string | null
}

export type BackupHealth =
  | { state: 'unconfigured' }
  | { state: 'ok'; lastSuccessAt: string }
  | { state: 'running'; since: string }
  | { state: 'failed'; at: string; error: string }
  | { state: 'missing'; lastSuccessAt: string | null; message: string }

/** ee's backup status: never a secret, never the key. */
export type BackupStatus = {
  configured: boolean
  target: (Omit<BackupTarget, 'secretAccessKey'> & { hasSecret: true }) | null
  schedule: { hour: number; minute: number } | null
  retentionDays: number | null
  configuredAt: string | null
  keyCreatedAt: string | null
  health: BackupHealth
  runs: BackupRun[]
}

/** A snapshot id, its UTC start time: 20261103T031700Z (ee/src/backup/restore.ts SNAPSHOT_ID). */
export const BACKUP_SNAPSHOT_ID = /^\d{8}T\d{6}Z$/

/** A complete snapshot in the bucket (ee/src/backup/restore.ts). */
export type BackupSnapshot = { id: string; takenAt: string }

export type RestoreStep =
  | 'verifying'
  | 'handover'
  | 'stopping'
  | 'restoring-state'
  | 'restoring-database'
  | 'restoring-files'
  | 'starting'
  | 'done'

/** The last check or restore of a backup, as ee records it (survives the restore's restart). */
export type RestoreJob = {
  id: string
  kind: 'check' | 'restore'
  snapshotId: string
  author: string
  status: 'running' | 'succeeded' | 'failed'
  step: RestoreStep
  startedAt: string
  updatedAt: string
  endedAt: string | null
  checked: { files: Array<{ name: string; size: number }>; blobs: number; blobBytes: number } | null
  error: string | null
  log: string[]
  announced: boolean
}

/** Where a box's releases come from (ee/src/release-source.ts). */
export type ReleaseSource = { kind: 'github'; repo: string } | { kind: 'dir'; path: string } | { kind: 'url'; base: string }

export type UpgradeStep = 'handover' | 'verifying' | 'safety-copy' | 'backup' | 'installing' | 'watching' | 'rolling-back' | 'done'

/** How an update ended (ee/src/upgrade.ts UpgradeOutcome): the release, what ran before, the step, ok or why not. */
export type UpgradeOutcome = {
  release: string
  from: string | null
  step: Exclude<UpgradeStep, 'handover'>
  ok: boolean
  reason: string | null
  /** The release before was put back live (its watch failed, or it never went live). */
  rolledBack: boolean
}

/** What `ee rollback` would do now (ee/src/rollback.ts): from, to, or why not. */
export type RollbackPlan = { from: string | null; to: string | null; refused: string | null }

/** The last update from Settings → Updates, as ee records it (ee/src/upgrade-job.ts; survives the restarts). */
export type UpgradeJob = {
  id: string
  /** The release approved: eigenenterprise-<version>-<sha>. */
  release: string
  from: string
  author: string
  status: 'running' | 'succeeded' | 'failed'
  step: UpgradeStep
  startedAt: string
  updatedAt: string
  endedAt: string | null
  installedBefore: string | null
  installedAfter: string | null
  /** The safety copy's directory on the server (ROLLBACK.txt inside says how to go back). */
  safetyCopy: string | null
  error: string | null
  log: string[]
  announced: boolean
  /** How it ended; null while it runs (and on jobs from before ee recorded it). */
  outcome: UpgradeOutcome | null
}

export type UpgradeInfo = {
  installed: { tarball: string; version: string } | null
  managed: boolean
  source: ReleaseSource | null
  job: UpgradeJob | null
  /** The newest update end in ee's journal, from Settings → Updates or from `ee upgrade` on the server. */
  lastOutcome: UpgradeOutcome | null
}

/** newer / rebuild (same version, another build) are offered; installed / older are not. */
export type LatestRelease = {
  name: string
  version: string
  notes: string | null
  from: string
  state: 'newer' | 'rebuild' | 'installed' | 'older'
}

/** A Drive folder previewed on this box (plan/phase-drive-app-preview.md, the ee ↔ kernel contract). */
export type PreviewState = 'installing' | 'starting' | 'running' | 'failed' | 'stopped'

export type PreviewView = {
  /** pv + 12 hex: sha256 of the Drive folder id (the kernel computes it, ee validates it). */
  id: string
  /** For "Another app is running: <name>". */
  folderName: string
  state: PreviewState
  /** <id>.preview.<console host> */
  host: string
  /** https://<host>/ */
  url: string
  /** null until ee has read package.json. */
  script: 'dev' | 'start' | null
  startedAt: string
  lastSeenAt: string
  /** Why it failed or stopped (e.g. "idle for 30 minutes", "add a lockfile …"). */
  error: string | null
  /** The last 200 lines: install + dev server output. */
  log: string[]
}

/** ee's problem type when another preview is active (409, with `running`). */
export const PREVIEW_BUSY = 'urn:ee:preview_busy'

/** ee refused a preview because another one is active: `running` is that one. */
export class PreviewBusyError extends SubstrateError {
  constructor(
    message: string,
    readonly running: PreviewView,
    body: unknown,
  ) {
    super(409, message, PREVIEW_BUSY, body)
  }
}

export class EeClient {
  constructor(private readonly transport: EeTransport = socketTransport()) {}

  /** What runs, where releases come from, the last update (no network on ee's side). */
  upgrade(): Promise<UpgradeInfo> {
    return this.call('GET', '/v1/upgrade')
  }

  /** The newest signed release at this box's source (ee fetches and verifies it). */
  latestRelease(): Promise<{ latest: LatestRelease }> {
    return this.call('GET', '/v1/upgrade/latest')
  }

  /** Update to `release` (the one the person approved); ee refuses anything else. */
  startUpgrade(i: { release: string; author: string }): Promise<{ job: UpgradeJob }> {
    return this.call('POST', '/v1/upgrade', i)
  }

  /** What a rollback would do now (a read: nothing changes). */
  rollbackPlan(): Promise<RollbackPlan> {
    return this.call('GET', '/v1/upgrade/rollback')
  }

  /** Put the release before back live (no restore); ee refuses below the downgrade floor. */
  rollback(i: { author: string; to?: string }): Promise<{ from: string; to: string }> {
    return this.call('POST', '/v1/upgrade/rollback', i)
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, data } = await this.transport(method, path, body)
    if (status >= 400) {
      const problem = data as { detail?: string; type?: string; running?: PreviewView } | null
      if (problem?.type === PREVIEW_BUSY) {
        if (!problem.running) throw new SubstrateError(status, `ee answered ${PREVIEW_BUSY} without the running preview`, PREVIEW_BUSY, data)
        throw new PreviewBusyError(problem.detail ?? `another preview is running: ${problem.running.folderName}`, problem.running, data)
      }
      throw new SubstrateError(
        status,
        problem?.detail ?? `HTTP ${status}`,
        problem?.type ?? null,
        data,
      )
    }
    return data as T
  }

  status(): Promise<EeStatus> {
    return this.call('GET', '/v1/status')
  }
  addDomain(i: {
    host: string
    workload: string
    role: 'console' | 'public' | 'app'
    author: string
  }): Promise<DomainSetResult> {
    return this.call('POST', '/v1/domains', i)
  }
  /** Caddy retries the host's certificate now (graceful reload; ends an ACME backoff). 404: ee does not serve the host. */
  retryCertificate(host: string, author: string): Promise<{ host: string; reloaded: true }> {
    return this.call('POST', '/v1/certificates/retry', { host, author })
  }
  removeDomain(i: { host: string; author: string }): Promise<ChangeResult> {
    return this.call('DELETE', '/v1/domains', i)
  }
  /** https url (+ optional one-fetch token), or git@github.com:owner/repo.git + a deploy key ee holds. */
  fetchSource(i: {
    name: string
    url: string
    ref: string
    token?: string
    deployKeyId?: string
  }): Promise<{ mirror: string; ref: string; rev: string }> {
    return this.call('POST', '/v1/sources/fetch', i)
  }
  /** ee generates an ed25519 pair and keeps the private half sealed; only the public key comes back. */
  createDeployKey(i: {
    repo: string
    author: string
  }): Promise<{ keyId: string; publicKey: string }> {
    return this.call('POST', '/v1/deploy-keys', i)
  }
  /** Read-only `git ls-remote` over SSH with the key and GitHub's pinned host keys. */
  checkDeployKey(
    keyId: string,
    i: { repo: string },
  ): Promise<
    { ok: true; branches: string[] } | { ok: false; error: 'not_accepted'; detail: string }
  > {
    return this.call('POST', `/v1/deploy-keys/${encodeURIComponent(keyId)}/check`, i)
  }
  deleteDeployKey(keyId: string, i: { author: string }): Promise<{ ok: true }> {
    return this.call('DELETE', `/v1/deploy-keys/${encodeURIComponent(keyId)}`, i)
  }
  createApp(i: {
    name: string
    source: { kind: 'git'; mirror: string; ref: string; rev: string }
    env: Record<string, string>
    secrets: string[]
    deploy: { auto: boolean }
    /** The owner's contract when the repo has no ee.json (ee keeps it in the company repo). */
    contract?: AppContract
    author: string
  }): Promise<ChangeResult> {
    return this.call('POST', '/v1/apps', i)
  }
  /** What eigen provides (D16): runtimes, services, capabilities. */
  catalog(): Promise<Catalog> {
    return this.call('GET', '/v1/catalog')
  }
  /** The repo's own ee.json at a rev, read from ee's local mirror. */
  sourceContract(i: { name: string; rev: string }): Promise<RepoContract> {
    const q = new URLSearchParams({ name: i.name, rev: i.rev })
    return this.call('GET', `/v1/sources/contract?${q}`)
  }
  /** A bounded file list of the mirror at a rev (depth 1..4). */
  sourceTree(i: { name: string; rev: string; depth: number }): Promise<SourceTree> {
    const q = new URLSearchParams({ name: i.name, rev: i.rev, depth: String(i.depth) })
    return this.call('GET', `/v1/sources/tree?${q}`)
  }
  /** One text file (≤64KB) of the mirror at a rev; ee refuses paths outside the repo. */
  sourceFile(i: { name: string; rev: string; path: string }): Promise<SourceFile> {
    const q = new URLSearchParams({ name: i.name, rev: i.rev, path: i.path })
    return this.call('GET', `/v1/sources/file?${q}`)
  }
  /** One workload's journal events (deploy history), oldest first. */
  events(workload: string): Promise<{ workload: string; events: EeEvent[] }> {
    return this.call('GET', `/v1/events?${new URLSearchParams({ workload })}`)
  }
  /** The live slot's recent journal lines. 404 when nothing is live. */
  logs(workload: string): Promise<{ workload: string; lines: string[] }> {
    return this.call('GET', `/v1/logs?${new URLSearchParams({ workload })}`)
  }
  /** One workload's deploy attempts (stages, status, the plain cause), newest first. */
  deploys(workload: string): Promise<{ workload: string; deploys: EeDeploy[] }> {
    return this.call('GET', `/v1/deploys?${new URLSearchParams({ workload })}`)
  }
  /** One attempt's bounded, secret-redacted build + start log. */
  deployLog(id: string): Promise<{ deploy: EeDeploy; lines: string[] }> {
    return this.call('GET', `/v1/deploys/${encodeURIComponent(id)}/log`)
  }
  /** The repo's file names at a rev, from ee's local mirror. */
  sourceFiles(i: { name: string; rev: string }): Promise<{ files: string[]; truncated: boolean }> {
    return this.call(
      'GET',
      `/v1/sources/files?${new URLSearchParams({ name: i.name, rev: i.rev })}`,
    )
  }
  deploy(i: { workload: string; rev: string; author: string }): Promise<ChangeResult> {
    return this.call('POST', '/v1/deploy', i)
  }
  removeApp(i: { name: string; author: string }): Promise<ChangeResult> {
    return this.call('DELETE', '/v1/apps', i)
  }
  /** Backup config (no secrets), health and the last runs. */
  backups(): Promise<BackupStatus> {
    return this.call('GET', '/v1/backups')
  }
  /** Write, read back and delete one object in the bucket; saves nothing (no secret: the saved one). */
  testBackupTarget(
    target: Omit<BackupTarget, 'secretAccessKey'> & { secretAccessKey?: string },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.call('POST', '/v1/backups/test', { target })
  }
  /**
   * Owner only (D11). backupKey (base64) is derived from the company root key
   * (gitstore deriveBackupKey); required the first time, ee seals it.
   */
  configureBackups(i: {
    target: Omit<BackupTarget, 'secretAccessKey'> & { secretAccessKey?: string }
    schedule: { hour: number }
    retentionDays: number
    backupKey?: string
    author: string
  }): Promise<{ config: BackupStatus }> {
    return this.call('POST', '/v1/backups/config', i)
  }
  /** Start a backup now; returns the running record. */
  runBackup(i: { author: string }): Promise<{ run: BackupRun }> {
    return this.call('POST', '/v1/backups/run', { ...i, trigger: 'manual', wait: false })
  }
  /** Complete snapshots in the bucket, newest first. */
  backupSnapshots(): Promise<{ snapshots: BackupSnapshot[] }> {
    return this.call('GET', '/v1/backups/snapshots')
  }
  /** The last check/restore job (null when there never was one). */
  restoreJob(): Promise<{ job: RestoreJob | null }> {
    return this.call('GET', '/v1/backups/restore')
  }
  /** Owner only (D11). Download + decrypt + hash a snapshot in ee; writes nothing. */
  checkBackup(i: { snapshotId: string; author: string }): Promise<{ job: RestoreJob }> {
    return this.call('POST', '/v1/backups/check', i)
  }
  /**
   * Owner only (D11). ee verifies the snapshot, then replaces this whole server
   * with it and restarts. backupKey (base64) is derived from the recovery code
   * the owner just typed — it is passed through, never stored or logged.
   */
  restoreBackup(i: { snapshotId: string; backupKey: string; author: string }): Promise<{ job: RestoreJob }> {
    return this.call('POST', '/v1/backups/restore', i)
  }
  /**
   * Run a Drive folder snapshot (a tarball under $EE_STATE_DIR/previews/) as
   * preview `id`. The same id restarts it from the new tarball; another
   * active id → PreviewBusyError.
   */
  startPreview(i: {
    id: string
    tarball: string
    sha256: string
    folderName: string
    author: string
  }): Promise<{ preview: PreviewView }> {
    return this.call('POST', '/v1/previews', i)
  }
  previews(): Promise<{ previews: PreviewView[] }> {
    return this.call('GET', '/v1/previews')
  }
  /** One preview; SubstrateError 404 when ee doesn't know the id. */
  preview(id: string): Promise<{ preview: PreviewView }> {
    return this.call('GET', `/v1/previews/${encodeURIComponent(id)}`)
  }
  /** Someone has the preview open: resets its idle clock. */
  previewSeen(id: string): Promise<{ preview: PreviewView }> {
    return this.call('POST', `/v1/previews/${encodeURIComponent(id)}/seen`, {})
  }
  /** Stops the preview and removes its files (state `stopped`). */
  stopPreview(id: string, i: { author: string }): Promise<{ preview: PreviewView }> {
    return this.call('DELETE', `/v1/previews/${encodeURIComponent(id)}`, i)
  }
  setSecret(i: {
    workload: string
    name: string
    value: string
    author: string
  }): Promise<{ ok: true; reconcileError: string | null }> {
    return this.call('POST', '/v1/secrets', i)
  }

  // ─── Company modules (plan/phase-upgrades-u2.md §5, contracts/module-workload.ts) ─
  // Every body is checked against the contract before it leaves, and every
  // answer when it arrives: a mismatch with ee fails loud, never half-works.

  /** POST /v1/modules: deploy a receipted bundle (202 { module }); stop-then-start for the same id. */
  async deployModule(request: DeployModuleRequest): Promise<ModuleView> {
    const body = deployModuleRequestSchema.parse({ ...request, dryRun: undefined })
    return moduleAnswerSchema.parse(await this.call('POST', '/v1/modules', body)).module
  }
  /** POST /v1/modules with dryRun: build and test only ({ passed, log }). */
  async dryRunModule(request: DeployModuleRequest): Promise<DryRunAnswer> {
    const body = deployModuleRequestSchema.parse({ ...request, dryRun: true })
    return dryRunAnswerSchema.parse(await this.call('POST', '/v1/modules', body))
  }
  async modules(): Promise<ModuleView[]> {
    return moduleListAnswerSchema.parse(await this.call('GET', '/v1/modules')).modules
  }
  /** One module; null when ee answers 404 urn:ee:module_not_found. */
  async module(id: string): Promise<ModuleView | null> {
    try {
      return moduleAnswerSchema.parse(await this.call('GET', `/v1/modules/${encodeURIComponent(moduleIdParam.parse(id))}`)).module
    } catch (err) {
      if (err instanceof SubstrateError && err.type === MODULE_PROBLEM_TYPES.moduleNotFound) return null
      throw err
    }
  }
  async stopModule(id: string, body: StopModuleRequest): Promise<ModuleView> {
    const path = `/v1/modules/${encodeURIComponent(moduleIdParam.parse(id))}/stop`
    return moduleAnswerSchema.parse(await this.call('POST', path, stopModuleRequestSchema.parse(body))).module
  }
  async startModule(id: string, body: StartModuleRequest): Promise<ModuleView> {
    const path = `/v1/modules/${encodeURIComponent(moduleIdParam.parse(id))}/start`
    return moduleAnswerSchema.parse(await this.call('POST', path, startModuleRequestSchema.parse(body))).module
  }
  async moduleLogs(id: string, lines: number): Promise<string[]> {
    const q = moduleLogsQuerySchema.parse({ lines })
    const path = `/v1/modules/${encodeURIComponent(moduleIdParam.parse(id))}/logs?lines=${q.lines}`
    return moduleLogsAnswerSchema.parse(await this.call('GET', path)).lines
  }
  async removeModule(id: string, body: RemoveModuleRequest): Promise<ModuleView> {
    const path = `/v1/modules/${encodeURIComponent(moduleIdParam.parse(id))}`
    return moduleAnswerSchema.parse(await this.call('DELETE', path, removeModuleRequestSchema.parse(body))).module
  }
}
