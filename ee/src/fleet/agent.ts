import type { BackupConfig, BackupRun, Health } from '../backup/service.ts'
import type { DesiredState, Settings } from '../company-repo.ts'
import { generateSecret } from '../secrets.ts'
import { EE_VERSION } from '../version.ts'
import {
  enrollRequestV1,
  enrollResponseV1,
  FLEET_FEATURES,
  FLEET_PATHS,
  FLEET_PROTOCOL,
  newBoxKey,
  parseDesired,
  POLL_SECONDS,
  reportV1,
  signFleetRequest,
  type DesiredV1,
  type FleetFeature,
  type ReportV1,
} from './protocol.ts'

/**
 * Managed mode (plan/phase-managed-box.md M4): a box enrolled with a hosting
 * control plane pulls its desired state every pollSeconds and converges to it,
 * level-triggered — each field is applied only when it differs from what the
 * box has. A box that was never enrolled (settings.managed = null) never polls.
 */

/** Secret-store scope for the box key. */
export const FLEET_SCOPE = 'fleet'
export const BOX_KEY = 'BOX_PRIVATE_KEY'
/** Marks a backup target the fleet configured (never touch one the owner set by hand). */
export const FLEET_BACKUP_MARK = 'BACKUP_SET_BY_FLEET'
/** Bearer token ee uses for os's loopback /api/fleet/seats; in the os workload's env. */
export const LOCAL_TOKEN = 'EE_FLEET_LOCAL_TOKEN'
export const PLATFORM_AI_SECRETS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL_CHAT', 'LLM_MODEL_EMBEDDING'] as const
export const UPGRADE_UNIT = 'ee-fleet-upgrade'
export const FLEET_AUTHOR = 'fleet'
/** Fleet-set backups: daily at 03:xx UTC, kept 30 days (the target is the control plane's; the cadence is ee's). */
export const FLEET_BACKUP_SCHEDULE = { hour: 3 } as const
export const FLEET_BACKUP_RETENTION_DAYS = 30

/** Exactly the desired-state features this box implements. */
export const IMPLEMENTED_FEATURES: FleetFeature[] = [...FLEET_FEATURES]

export class FleetError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Mutate = (s: Omit<DesiredState, 'rev'>) => Omit<DesiredState, 'rev'>

/** Everything the agent needs from the box (daemon.ts wires the real one; specs a fake). */
export type FleetHost = {
  read(): Promise<Omit<DesiredState, 'rev'>>
  /** validate → commit → reconcile (Ee.change). */
  change(message: string, mutate: Mutate): Promise<{ reconcileError: string | null }>
  reconcile(): Promise<void>
  secrets: {
    all(): Record<string, Record<string, string>>
    set(scope: string, name: string, value: string): Promise<void>
    delete(scope: string, name: string): Promise<boolean>
  }
  osRelease(): Promise<string | null>
  osHealth(): Promise<'healthy' | 'unhealthy' | 'unknown'>
  reconcileError(): string | null
  disk(): Promise<{ usedGb: number; totalGb: number } | null>
  /** GET os /api/fleet/seats with the token; null when os can't say. */
  seats(token: string): Promise<number | null>
  /** GET os /api/fleet/backup-key with the token (base64); throws with os's reason. Never logged. */
  backupKey(token: string): Promise<string>
  backups: {
    /** A backup key is sealed on this box. */
    hasKey(): boolean
    config(): BackupConfig | null
    configure(input: unknown): Promise<unknown>
    /** Drop the saved target (the sealed key stays). */
    unconfigure(author: string): Promise<void>
    status(): Promise<{ health: Health; runs: BackupRun[] }>
    start(trigger: 'manual', author: string): Promise<unknown>
    isRunning(): boolean
  }
  upgradeActive(): Promise<boolean>
  startUpgrade(from: string): Promise<void>
  fetch: typeof fetch
  now(): Date
  /** Loud: journal (when new) + stderr. Never given a secret value. */
  log(type: string, message: string): Promise<void>
}

export type PollResult = { at: string; ok: boolean; error: string | null; ignoredFields: string[] }

const httpsOrigin = (raw: string): string => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new FleetError(400, `--control-plane "${raw}" is not a URL`)
  }
  if (u.protocol !== 'https:') throw new FleetError(400, `--control-plane must be https (got ${u.protocol})`)
  if (u.origin !== raw.replace(/\/$/, '')) throw new FleetError(400, `--control-plane must be an origin like https://hosting.example.com (got ${raw})`)
  return u.origin
}

async function failText(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).trim().slice(0, 300)
}

export class FleetAgent {
  lastPoll: PollResult | null = null
  private ignoredFields: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private polling: Promise<PollResult> | null = null
  private lastLogged: string | null = null

  constructor(private readonly host: FleetHost) {}

  /** One-time: trade the enroll token for a box id, seal the box key, switch managed mode on. */
  async enroll(input: { controlPlane: string; token: string }): Promise<NonNullable<Settings['managed']>> {
    const current = (await this.host.read()).settings.managed
    if (current) throw new FleetError(409, `already enrolled with ${current.controlPlane} as box ${current.boxId}`)
    const origin = httpsOrigin(input.controlPlane)
    const key = newBoxKey()
    const request = enrollRequestV1.safeParse({ protocol: FLEET_PROTOCOL, enrollToken: input.token, publicKey: key.publicKey, eeVersion: EE_VERSION, features: IMPLEMENTED_FEATURES })
    if (!request.success) throw new FleetError(400, `enroll request invalid (the token must be 32–128 characters): ${request.error.issues.map((i) => i.path.join('.')).join(', ')}`)
    // Sealed before the control plane learns the public half: an answered enroll never leaves a box without its key.
    await this.host.secrets.set(FLEET_SCOPE, BOX_KEY, key.privateKey)
    const url = `${origin}${FLEET_PATHS.enroll}`
    let res: Response
    try {
      res = await this.host.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.data) })
    } catch (err) {
      throw new FleetError(502, `enroll: ${url} unreachable: ${(err as Error).message}`)
    }
    if (!res.ok) throw new FleetError(502, `enroll: ${url} answered ${res.status}: ${await failText(res)}`)
    const answer = enrollResponseV1.safeParse(await res.json().catch(() => null))
    if (!answer.success) throw new FleetError(502, `enroll: ${url} answered something that is not an enroll response: ${answer.error.message}`)
    const managed = { controlPlane: origin, boxId: answer.data.boxId, pollSeconds: answer.data.pollSeconds }
    if (!this.host.secrets.all()['os']?.[LOCAL_TOKEN]) await this.host.secrets.set('os', LOCAL_TOKEN, generateSecret(32))
    const r = await this.host.change(`managed: enrolled with ${origin} as box ${managed.boxId}`, (s) => ({
      ...declareOnOs(s, [LOCAL_TOKEN], []),
      settings: { ...s.settings, managed },
    }))
    await this.host.log('fleet.enrolled', `enrolled with ${origin} as box ${managed.boxId}, polling every ${managed.pollSeconds}s${r.reconcileError ? ` (reconcile: ${r.reconcileError})` : ''}`)
    this.start()
    return managed
  }

  /** Start the poll loop (daemon start, after enroll). A no-op while not managed. */
  start(): void {
    if (this.timer) return
    const loop = async () => {
      let seconds: number | null = null
      try {
        seconds = (await this.host.read()).settings.managed?.pollSeconds ?? null
        if (seconds === null) {
          this.timer = null
          return
        }
        await this.poll()
        seconds = (await this.host.read()).settings.managed?.pollSeconds ?? seconds
      } catch (err) {
        console.error(`fleet: ${(err as Error).message}`)
      }
      this.timer = setTimeout(loop, (seconds ?? POLL_SECONDS.default) * 1000)
    }
    this.timer = setTimeout(loop, 0)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One poll at a time; a second caller gets the running one. Never throws: the error is the result. */
  poll(): Promise<PollResult> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null
    })
    return this.polling
  }

  private async pollOnce(): Promise<PollResult> {
    const at = this.host.now().toISOString()
    try {
      const state = await this.host.read()
      const managed = state.settings.managed
      if (!managed) throw new Error('not enrolled')
      const privateKey = this.host.secrets.all()[FLEET_SCOPE]?.[BOX_KEY]
      if (!privateKey) throw new Error(`the box key is missing from the secret store (${FLEET_SCOPE}/${BOX_KEY}); this box cannot sign its polls`)
      const body = JSON.stringify(await this.report(state))
      const headers = signFleetRequest({ boxId: managed.boxId, privateKey, method: 'POST', path: FLEET_PATHS.poll, body, now: this.host.now().getTime() })
      const url = `${managed.controlPlane}${FLEET_PATHS.poll}`
      const res = await this.host.fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })
      if (!res.ok) throw new Error(`${url} answered ${res.status}: ${await failText(res)}`)
      const { desired, ignoredFields } = parseDesired(await res.json())
      this.ignoredFields = ignoredFields
      const errors = await this.apply(desired)
      if (errors.length > 0) throw new Error(`applying the desired state: ${errors.join('; ')}`)
      this.lastPoll = { at, ok: true, error: null, ignoredFields }
      this.lastLogged = null
    } catch (err) {
      const error = (err as Error).message
      this.lastPoll = { at, ok: false, error, ignoredFields: this.ignoredFields }
      console.error(`fleet poll failed: ${error}`)
      // The journal gets each distinct failure once; stderr (the systemd journal) gets every one.
      if (error !== this.lastLogged) {
        this.lastLogged = error
        await this.host.log('fleet.poll_failed', `fleet poll failed (retried every tick): ${error}`).catch(() => undefined)
      }
    }
    return this.lastPoll
  }

  async report(state: Omit<DesiredState, 'rev'>): Promise<ReportV1> {
    const token = this.host.secrets.all()['os']?.[LOCAL_TOKEN]
    const reconcileError = this.host.reconcileError()
    const hosts = [...new Set([...state.routes.map((r) => r.host), ...(state.settings.callsHost ? [state.settings.callsHost] : [])])]
    const b = await this.host.backups.status()
    const lastOk = b.runs.find((r) => r.status === 'succeeded')
    const backupError = b.health.state === 'failed' ? b.health.error : b.health.state === 'missing' ? b.health.message : null
    return reportV1.parse({
      protocol: FLEET_PROTOCOL,
      eeVersion: EE_VERSION,
      features: IMPLEMENTED_FEATURES,
      release: await this.host.osRelease(),
      health: { os: await this.host.osHealth(), reconcileError: reconcileError === null ? null : reconcileError.replace(/\s*\n\s*/g, ' ').slice(0, 2000) },
      seats: token ? await this.host.seats(token) : null,
      hosts: hosts.slice(0, 200),
      disk: await this.host.disk(),
      backup: b.health.state === 'unconfigured' ? null : { lastOkAt: lastOk ? (lastOk.endedAt ?? lastOk.startedAt) : null, lastError: backupError?.slice(0, 2000) ?? null },
      ignoredFields: this.ignoredFields,
    })
  }

  /** Apply each field independently; one failing never blocks the others. Returns the failures. */
  async apply(d: DesiredV1): Promise<string[]> {
    const errors: string[] = []
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`)
      }
    }
    await step('pollSeconds', () => this.applyPollSeconds(d.pollSeconds))
    if (d.suspended !== undefined) await step('suspended', () => this.applySuspended(d.suspended!))
    if (d.platformAi !== undefined) await step('platformAi', () => this.applyPlatformAi(d.platformAi!))
    if (d.backup !== undefined) await step('backup', () => this.applyBackup(d.backup!))
    if (d.backupRequestedAt !== undefined && d.backupRequestedAt !== null) await step('backupRequestedAt', () => this.applyBackupNow(d.backupRequestedAt!))
    if (d.release !== undefined && d.release !== null) await step('release', () => this.applyRelease(d.release!))
    return errors
  }

  private async applyPollSeconds(pollSeconds: number): Promise<void> {
    const managed = (await this.host.read()).settings.managed
    if (!managed || managed.pollSeconds === pollSeconds) return
    await this.host.change(`managed: poll every ${pollSeconds}s`, (s) => ({ ...s, settings: { ...s.settings, managed: { ...managed, pollSeconds } } }))
  }

  private async applySuspended(suspended: boolean): Promise<void> {
    if ((await this.host.read()).settings.suspended === suspended) return
    const r = await this.host.change(suspended ? 'managed: suspended (every host answers 503)' : 'managed: resumed', (s) => ({ ...s, settings: { ...s.settings, suspended } }))
    await this.host.log(suspended ? 'fleet.suspended' : 'fleet.resumed', suspended ? 'the control plane paused this company: every host answers 503' : 'the control plane resumed this company')
    if (r.reconcileError) throw new Error(r.reconcileError)
  }

  private async applyPlatformAi(ai: DesiredV1['platformAi']): Promise<void> {
    const want: Record<(typeof PLATFORM_AI_SECRETS)[number], string> | null = ai
      ? { LLM_BASE_URL: ai.llmBaseUrl, LLM_API_KEY: ai.llmApiKey, LLM_MODEL_CHAT: ai.llmModelChat, LLM_MODEL_EMBEDDING: ai.llmModelEmbedding }
      : null
    const have = this.host.secrets.all()['os'] ?? {}
    const state = await this.host.read()
    const declared = state.workloads.find((w) => w.name === 'os')?.secrets ?? []
    const same = PLATFORM_AI_SECRETS.every((n) => (want ? have[n] === want[n] && declared.includes(n) : have[n] === undefined && !declared.includes(n)))
    if (same) return
    if (want) for (const n of PLATFORM_AI_SECRETS) if (have[n] !== want[n]) await this.host.secrets.set('os', n, want[n])
    const message = want ? 'managed: platform AI set for os' : 'managed: platform AI removed from os'
    const needsDeclare = want ? PLATFORM_AI_SECRETS.some((n) => !declared.includes(n)) : PLATFORM_AI_SECRETS.some((n) => declared.includes(n))
    // New values on declared secrets change os's fingerprint, so a plain reconcile redeploys it (health-gated).
    if (needsDeclare) {
      const r = await this.host.change(message, (s) => declareOnOs(s, want ? [...PLATFORM_AI_SECRETS] : [], want ? [] : [...PLATFORM_AI_SECRETS]))
      if (r.reconcileError) throw new Error(r.reconcileError)
    } else {
      await this.host.reconcile()
    }
    // Undeclared first, then forgotten: os never runs with a declared secret that has no value.
    if (!want) for (const n of PLATFORM_AI_SECRETS) await this.host.secrets.delete('os', n)
    await this.host.log('fleet.platform_ai', want ? `platform AI set for os (${ai!.llmBaseUrl}, ${ai!.llmModelChat})` : 'platform AI removed from os')
  }

  private fleetOwnsBackup(): boolean {
    return this.host.secrets.all()[FLEET_SCOPE]?.[FLEET_BACKUP_MARK] === '1'
  }

  private async applyBackup(target: DesiredV1['backup']): Promise<void> {
    const cfg = this.host.backups.config()
    const owned = this.fleetOwnsBackup()
    if (target === null) {
      if (!owned) return
      if (cfg) await this.host.backups.unconfigure(FLEET_AUTHOR)
      await this.host.secrets.delete(FLEET_SCOPE, FLEET_BACKUP_MARK)
      return
    }
    // The owner set backups up by hand: theirs, never overwritten.
    if (cfg && !owned) return
    const next = { ...target!, addressing: 'path' as const }
    if (cfg && (Object.keys(next) as Array<keyof typeof next>).every((k) => cfg.target[k] === next[k])) return
    // No key sealed yet: only os can derive it (from the company root key); ask it on loopback.
    // A failure throws into the poll's error and the next tick tries again.
    let backupKey: string | undefined
    if (!this.host.backups.hasKey()) {
      const token = this.host.secrets.all()['os']?.[LOCAL_TOKEN]
      if (!token) throw new Error(`no backup key sealed and no ${LOCAL_TOKEN} to ask os for it`)
      backupKey = await this.host.backupKey(token)
    }
    // Mark first: a target saved by this call is the fleet's even if ee stops right after.
    if (!owned) await this.host.secrets.set(FLEET_SCOPE, FLEET_BACKUP_MARK, '1')
    try {
      await this.host.backups.configure({
        target: next,
        schedule: FLEET_BACKUP_SCHEDULE,
        retentionDays: FLEET_BACKUP_RETENTION_DAYS,
        author: FLEET_AUTHOR,
        ...(backupKey ? { backupKey } : {}),
      })
    } catch (err) {
      if (!cfg) await this.host.secrets.delete(FLEET_SCOPE, FLEET_BACKUP_MARK)
      throw err
    }
  }

  private async applyBackupNow(requestedAt: string): Promise<void> {
    if (!this.host.backups.config() || this.host.backups.isRunning()) return
    const { runs } = await this.host.backups.status()
    const asked = new Date(requestedAt).getTime()
    // Any run started at or after the request answers it (a failed one is reported, not retried every tick).
    if (runs.some((r) => new Date(r.startedAt).getTime() >= asked)) return
    await this.host.backups.start('manual', FLEET_AUTHOR)
  }

  private async applyRelease(release: NonNullable<DesiredV1['release']>): Promise<void> {
    if ((await this.host.osRelease()) === release.name) return
    if (await this.host.upgradeActive()) return
    await this.host.startUpgrade(release.from)
    await this.host.log('fleet.upgrade_started', `upgrading to ${release.name} from ${release.from} (${UPGRADE_UNIT}.service)`)
  }
}

/** Add/remove names on the os workload's declared secrets. */
function declareOnOs(s: Omit<DesiredState, 'rev'>, add: string[], remove: string[]): Omit<DesiredState, 'rev'> {
  if (!s.workloads.some((w) => w.name === 'os')) throw new Error('no os workload in the company repo')
  return {
    ...s,
    workloads: s.workloads.map((w) =>
      w.name === 'os' ? { ...w, secrets: [...new Set([...w.secrets.filter((n) => !remove.includes(n)), ...add])] } : w,
    ),
  }
}
