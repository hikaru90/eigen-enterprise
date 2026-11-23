import type { BackupConfig, BackupRun, Health } from '../backup/service.ts'
import type { DesiredState, Settings } from '../company-repo.ts'
import { addDomain, removeDomain } from '../domains.ts'
import { generateSecret } from '../secrets.ts'
import { releaseOf } from '../upgrade.ts'
import { EE_VERSION } from '../version.ts'
import {
  enrollRequestV1,
  escrowRequestV1,
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
  type DomainClaimV1,
  type FleetFeature,
  type HostedAddressV1,
  type ReportV1,
} from './protocol.ts'
import type { HostedAddressRecord } from './hosted-address.ts'

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
/**
 * The hosting's platform AI on os = eigenInference (CB1), under names that say what they are (os reads them as its
 * eigenInference credential, never as BYOK); all or none. One key per company covers every model slot: chat,
 * embeddings, speech to text, text to speech and decisions (os `src/lib/server/llm/platform-ai.ts` states the
 * contract). os pins `_MODEL_EMBEDDING` as the install's embedding model and no longer reads `_MODEL_CHAT`.
 */
export const PLATFORM_AI_SECRETS = ['PLATFORM_LLM_BASE_URL', 'PLATFORM_LLM_API_KEY', 'PLATFORM_LLM_MODEL_CHAT', 'PLATFORM_LLM_MODEL_EMBEDDING'] as const
/**
 * Where an older ee put the platform AI: os's self-hosted BYOK names, so os mistook it for the owner's own key.
 * On a managed box these were always the fleet's (every platformAi poll overwrote or removed them); the platformAi step retires them.
 */
export const LEGACY_PLATFORM_AI_SECRETS = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL_CHAT', 'LLM_MODEL_EMBEDDING'] as const
export const MAIL_SECRETS = ['EE_MAIL_REGION', 'EE_MAIL_ACCESS_KEY_ID', 'EE_MAIL_SECRET_ACCESS_KEY', 'EE_MAIL_TENANT', 'EE_MAIL_CONFIG_SET', 'EE_MAIL_TRACKING_CONFIG_SET', 'EE_MAIL_EVENTS_TOPIC_ARN', 'EE_MAIL_INBOUND_TOPIC_ARN', 'EE_MAIL_INBOUND_BUCKET', 'EE_MAIL_INBOUND_PREFIX'] as const
/** os's credential for the control plane's domains API (plan/managed-domains.md DM6); all or none. */
export const DOMAINS_SECRETS = ['EE_DOMAINS_API_BASE', 'EE_DOMAINS_TOKEN'] as const
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
  /** GET os /api/fleet/seats with the token; throws with the reason when os doesn't answer (the agent journals it). */
  seats(token: string): Promise<number | null>
  /** GET os /api/fleet/mail-domains with the token; throws with the reason when os doesn't answer (e.g. an older os, or os without the token). */
  mailDomains(token: string): Promise<Array<{ name: string; receive: boolean }> | null>
  /** GET os /api/fleet/backup-key with the token (base64); throws with os's reason. Never logged. */
  backupKey(token: string): Promise<string>
  backups: {
    /** A backup key is sealed on this box. */
    hasKey(): boolean
    /** The sealed backup key (base64), null before one is sealed. Never logged. */
    key(): string | null
    config(): BackupConfig | null
    configure(input: unknown): Promise<unknown>
    /** Drop the saved target (the sealed key stays). */
    unconfigure(author: string): Promise<void>
    status(): Promise<{ health: Health; runs: BackupRun[] }>
    start(trigger: 'manual', author: string): Promise<unknown>
    isRunning(): boolean
  }
  upgradeActive(): Promise<boolean>
  /** `ee upgrade --from <from> --expect <release>` as a detached unit: it installs that release or nothing. */
  startUpgrade(from: string, release: string): Promise<void>
  fetch: typeof fetch
  now(): Date
  /** Loud: journal (when new) + stderr. Never given a secret value. */
  log(type: string, message: string): Promise<void>
  /** Store the company's domain claims as the control plane sent them (fleet/claims.ts); null clears them. */
  saveClaims(claims: DomainClaimV1[] | null): Promise<void>
  /** The stored hosted address + the public host the fleet added (fleet/hosted-address.ts); throws on a broken file. */
  readHostedAddress(): Promise<HostedAddressRecord>
  saveHostedAddress(record: HostedAddressRecord): Promise<void>
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
  /** Per loopback question, the last os failure journaled (each distinct one once). */
  private readonly osErrors = new Map<string, string>()
  /** The last release target an upgrade was started for, and when (a failed one is retried slowly). */
  private lastUpgrade: { release: string; at: number } | null = null

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
    const mailDomains = token ? await this.askOs('mailDomains', () => this.host.mailDomains(token)) : null
    return reportV1.parse({
      protocol: FLEET_PROTOCOL,
      eeVersion: EE_VERSION,
      features: IMPLEMENTED_FEATURES,
      release: await this.host.osRelease(),
      health: { os: await this.host.osHealth(), reconcileError: reconcileError === null ? null : reconcileError.replace(/\s*\n\s*/g, ' ').slice(0, 2000) },
      seats: token ? await this.askOs('seats', () => this.host.seats(token)) : null,
      hosts: hosts.slice(0, 200),
      disk: await this.host.disk(),
      backup: b.health.state === 'unconfigured' ? null : { lastOkAt: lastOk ? (lastOk.endedAt ?? lastOk.startedAt) : null, lastError: backupError?.slice(0, 2000) ?? null },
      ...(mailDomains ? { mail: { domains: mailDomains } } : {}),
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
    await step('localToken', () => this.applyLocalToken())
    await step('pollSeconds', () => this.applyPollSeconds(d.pollSeconds))
    if (d.suspended !== undefined) await step('suspended', () => this.applySuspended(d.suspended!))
    if (d.platformAi !== undefined) await step('platformAi', () => this.applyPlatformAi(d.platformAi!))
    if (d.mail !== undefined) await step('mail', () => this.applyMail(d.mail!))
    if (d.domains !== undefined) await step('domains', () => this.applyDomains(d.domains!))
    // Absent = a control plane that doesn't send claims: nothing to show, so nothing kept.
    await step('claims', () => this.host.saveClaims(d.claims ?? null))
    if (d.hostedAddress !== undefined) await step('hostedAddress', () => this.applyHostedAddress(d.hostedAddress!))
    if (d.backup !== undefined) await step('backup', () => this.applyBackup(d.backup!))
    if (d.escrowBackupKey === true) await step('escrowBackupKey', () => this.applyEscrowBackupKey())
    if (d.backupRequestedAt !== undefined && d.backupRequestedAt !== null) await step('backupRequestedAt', () => this.applyBackupNow(d.backupRequestedAt!))
    if (d.release !== undefined && d.release !== null) await step('release', () => this.applyRelease(d.release!))
    return errors
  }

  /**
   * The free hosted address (plan/hosted-address.md H5). Stored for os (ee status), and its `siteHost`
   * becomes os's public host only while os has none. One public host: an own domain the owner connects
   * (addDomain role public) replaces the fleet's siteHost, and the fleet then lets it go (journaled)
   * and never takes the website back while the owner's host stays. null removes siteHost only when the
   * fleet added it and it is still the public host. Absent (not sent) leaves everything as is.
   */
  private async applyHostedAddress(want: HostedAddressV1 | null): Promise<void> {
    const stored = await this.host.readHostedAddress()
    const save = async (record: HostedAddressRecord) => {
      if (JSON.stringify(record) !== JSON.stringify({ hostedAddress: stored.hostedAddress, fleetSiteHost: stored.fleetSiteHost })) await this.host.saveHostedAddress(record)
    }
    const pub = (await this.host.read()).settings.publicHost
    let fleetSiteHost = stored.fleetSiteHost
    if (fleetSiteHost !== null && pub !== null && pub !== fleetSiteHost) {
      await this.host.log('fleet.hosted_site_displaced', `the website now runs on ${pub}; the free hosted address ${fleetSiteHost} is no longer the public host (the own domain wins)`)
      fleetSiteHost = null
    }
    if (want === null) {
      if (fleetSiteHost !== null && pub === fleetSiteHost) {
        const host = fleetSiteHost
        await this.changeOrThrow(`managed: free hosted address ${host} removed as the website host`, (s) => removeDomain(s, host))
        await this.host.log('fleet.hosted_site_removed', `the free hosted address ${host} is no longer the website host (the control plane withdrew it)`)
      }
      await save({ hostedAddress: null, fleetSiteHost: null })
      return
    }
    // Ours to (re)place: no public host at all, or the fleet's own one under an old name.
    const place = pub === null || (fleetSiteHost !== null && pub === fleetSiteHost && pub !== want.siteHost)
    if (!place) {
      await save({ hostedAddress: want, fleetSiteHost })
      return
    }
    const site = want.siteHost
    const state = await this.host.read()
    const taken = state.routes.find((r) => r.host === site && r.workload !== 'os')
    if (taken) throw new Error(`${site} is already routed to ${taken.workload}; it cannot become the website host`)
    // Provenance first: a host this step adds is the fleet's even if ee stops before the commit.
    await save({ hostedAddress: want, fleetSiteHost: site })
    await this.changeOrThrow(`managed: free hosted address ${site} is the website host`, (s) => addDomain(s, { host: site, workload: 'os', role: 'public' }))
    await this.host.log('fleet.hosted_site_added', `the website runs on the free hosted address ${site} until the company connects its own domain`)
  }

  private async changeOrThrow(message: string, mutate: Mutate): Promise<void> {
    const r = await this.host.change(message, mutate)
    if (r.reconcileError) throw new Error(r.reconcileError)
  }

  /** Hand the control plane a copy of the sealed backup key (owner decision D7). None sealed yet → a later poll sends it. */
  private async applyEscrowBackupKey(): Promise<void> {
    const backupKey = this.host.backups.key()
    if (backupKey === null) return
    const managed = (await this.host.read()).settings.managed
    if (!managed) throw new Error('not enrolled')
    const privateKey = this.host.secrets.all()[FLEET_SCOPE]?.[BOX_KEY]
    if (!privateKey) throw new Error(`the box key is missing from the secret store (${FLEET_SCOPE}/${BOX_KEY}); this box cannot sign its escrow request`)
    const body = JSON.stringify(escrowRequestV1.parse({ protocol: FLEET_PROTOCOL, backupKey }))
    const headers = signFleetRequest({ boxId: managed.boxId, privateKey, method: 'POST', path: FLEET_PATHS.escrow, body, now: this.host.now().getTime() })
    const url = `${managed.controlPlane}${FLEET_PATHS.escrow}`
    const res = await this.host.fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body })
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${await failText(res)}`)
    await this.host.log('fleet.backup_key_escrowed', `the control plane (${managed.controlPlane}) now holds a copy of this box's backup key`)
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
      ? { PLATFORM_LLM_BASE_URL: ai.llmBaseUrl, PLATFORM_LLM_API_KEY: ai.llmApiKey, PLATFORM_LLM_MODEL_CHAT: ai.llmModelChat, PLATFORM_LLM_MODEL_EMBEDDING: ai.llmModelEmbedding }
      : null
    await this.applyOsSecrets(
      PLATFORM_AI_SECRETS,
      want,
      {
        set: 'managed: platform AI set for os',
        removed: 'managed: platform AI removed from os',
        type: 'fleet.platform_ai',
        log: want ? `platform AI set for os (${ai!.llmBaseUrl}, ${ai!.llmModelChat})` : 'platform AI removed from os',
      },
      LEGACY_PLATFORM_AI_SECRETS,
    )
  }

  private async applyMail(mail: DesiredV1['mail']): Promise<void> {
    const want: Record<(typeof MAIL_SECRETS)[number], string> | null = mail
      ? {
          EE_MAIL_REGION: mail.region,
          EE_MAIL_ACCESS_KEY_ID: mail.accessKeyId,
          EE_MAIL_SECRET_ACCESS_KEY: mail.secretAccessKey,
          EE_MAIL_TENANT: mail.tenant,
          EE_MAIL_CONFIG_SET: mail.configurationSet,
          EE_MAIL_TRACKING_CONFIG_SET: mail.trackingConfigurationSet,
          EE_MAIL_EVENTS_TOPIC_ARN: mail.eventsTopicArn,
          EE_MAIL_INBOUND_TOPIC_ARN: mail.inboundTopicArn,
          EE_MAIL_INBOUND_BUCKET: mail.inboundBucket,
          EE_MAIL_INBOUND_PREFIX: mail.inboundPrefix,
        }
      : null
    await this.applyOsSecrets(MAIL_SECRETS, want, {
      set: 'managed: mail set for os',
      removed: 'managed: mail removed from os',
      type: 'fleet.mail',
      log: want ? `managed mail set for os (${mail!.region}, tenant ${mail!.tenant})` : 'managed mail removed from os',
    })
  }

  /** The token is a secret: only the API base reaches the journal. */
  private async applyDomains(domains: DesiredV1['domains']): Promise<void> {
    const want: Record<(typeof DOMAINS_SECRETS)[number], string> | null = domains ? { EE_DOMAINS_API_BASE: domains.apiBase, EE_DOMAINS_TOKEN: domains.token } : null
    await this.applyOsSecrets(DOMAINS_SECRETS, want, {
      set: 'managed: domains API set for os',
      removed: 'managed: domains API removed from os',
      type: 'fleet.domains',
      log: want ? `managed domains API set for os (${domains!.apiBase})` : 'managed domains API removed from os',
    })
  }

  /**
   * Level-triggered: a set of os secrets the fleet owns, all or none. Values never reach a log or commit message.
   * `retired`: names the fleet set on os in an older ee and no longer uses; always brought to absent in the same step.
   */
  private async applyOsSecrets<N extends string>(names: readonly N[], want: Record<N, string> | null, text: { set: string; removed: string; type: string; log: string }, retired: readonly string[] = []): Promise<void> {
    const have = this.host.secrets.all()['os'] ?? {}
    const state = await this.host.read()
    const declared = state.workloads.find((w) => w.name === 'os')?.secrets ?? []
    const gone = (n: string) => have[n] === undefined && !declared.includes(n)
    const same = names.every((n) => (want ? have[n] === want[n] && declared.includes(n) : gone(n))) && retired.every(gone)
    if (same) return
    if (want) for (const n of names) if (have[n] !== want[n]) await this.host.secrets.set('os', n, want[n])
    const remove = [...(want ? [] : names), ...retired]
    const message = want ? text.set : text.removed
    const needsDeclare = (want ? names.some((n) => !declared.includes(n)) : false) || remove.some((n) => declared.includes(n))
    // New values on declared secrets change os's fingerprint, so a plain reconcile redeploys it (health-gated).
    if (needsDeclare) {
      const r = await this.host.change(message, (s) => declareOnOs(s, want ? [...names] : [], remove))
      if (r.reconcileError) throw new Error(r.reconcileError)
    } else {
      await this.host.reconcile()
    }
    // Undeclared first, then forgotten: os never runs with a declared secret that has no value.
    for (const n of remove) await this.host.secrets.delete('os', n)
    const retiredNow = retired.filter((n) => !gone(n))
    await this.host.log(text.type, retiredNow.length ? `${text.log}; retired ${retiredNow.join(', ')} (set by an older ee)` : text.log)
  }

  /**
   * os's loopback token (seats, mail domains, backup key), made at enroll. Kept declared on every
   * poll: a bootstrap re-run (every upgrade) rebuilds os's secret list without it, and os then
   * answers 404 to every loopback question.
   */
  private async applyLocalToken(): Promise<void> {
    const value = this.host.secrets.all()['os']?.[LOCAL_TOKEN] ?? generateSecret(32)
    await this.applyOsSecrets([LOCAL_TOKEN] as const, { [LOCAL_TOKEN]: value }, {
      set: 'managed: os loopback token declared',
      removed: 'managed: os loopback token removed',
      type: 'fleet.local_token',
      log: 'the os loopback token was missing on os and is declared again (seats, mail domains, backup key)',
    })
  }

  /** One loopback question to os for the report: a failure leaves the field out, goes to stderr every time and to the journal once per distinct error. */
  private async askOs<T>(question: string, ask: () => Promise<T | null>): Promise<T | null> {
    try {
      const answer = await ask()
      this.osErrors.delete(question)
      return answer
    } catch (err) {
      const error = (err as Error).message
      console.error(`fleet: ${error}`)
      if (this.osErrors.get(question) !== error) {
        this.osErrors.set(question, error)
        await this.host.log('fleet.os_unanswered', `${error} (the report goes out without it; asked again every poll)`).catch(() => undefined)
      }
      return null
    }
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
    // The target names a release; the box runs that release's tarball for its own CPU.
    const target = releaseOf(release.name)
    if (target === null) throw new Error(`the release target "${release.name.slice(0, 120)}" is not a release name`)
    const running = await this.host.osRelease()
    if (running !== null && releaseOf(running) === target) return
    if (await this.host.upgradeActive()) return
    const now = this.host.now().getTime()
    if (this.lastUpgrade?.release === target && now - this.lastUpgrade.at < UPGRADE_RETRY_MS) return
    this.lastUpgrade = { release: target, at: now }
    await this.host.startUpgrade(release.from, target)
    await this.host.log('fleet.upgrade_started', `upgrading to ${target} from ${release.from} (${UPGRADE_UNIT}.service)`)
  }
}

/** A started upgrade that didn't bring the target (refused, failed, rolled back) is started again after this, not every poll. */
const UPGRADE_RETRY_MS = 15 * 60_000

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
