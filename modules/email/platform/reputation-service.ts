import type { OwleryService } from '../owlery/service'
import type { EmailStore, ReputationCheckRow, ReputationResetRow } from './store'
import { describeSesError } from '../owlery/ses'
import {
  evaluateReputation,
  reputationRefusal,
  sliceLabel,
  REPUTATION_WINDOW,
  type AwsReputation,
  type ReputationState,
  type SendSlice,
} from './reputation'

/**
 * Sender reputation over time (plan/mail-reputation.md): reads the ledger
 * window and Amazon's verdict, records every check, answers the send gate
 * (R5) and the admins' resume (R6). Amazon is read on the hourly tick and on
 * "Check now", never per send; the gate uses the last recorded verdict.
 */

export type ReputationStore = Pick<
  EmailStore,
  | 'reputationWindow'
  | 'insertReputationCheck'
  | 'listReputationChecks'
  | 'insertReputationReset'
  | 'listReputationResets'
>

export type ReputationServiceDeps = {
  store: ReputationStore
  owlery: Pick<OwleryService, 'settings' | 'ses'>
  now?: () => Date
}

/** Something the admin must do differently (shown as is). */
export class ReputationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReputationError'
  }
}

/** How often the tick re-reads Amazon (R7). */
export const REPUTATION_CHECK_EVERY_MS = 60 * 60 * 1000
/** How long the send gate trusts its last evaluation (a burst of flow sends reads the ledger once). */
const GATE_CACHE_MS = 60_000

export type ReputationView = ReputationState & {
  mode: 'own' | 'managed' | null
  /** The window starts here: 30 days back, or the last resume. */
  since: Date
  lastCheck: { at: Date; awsError: string | null } | null
}

const AWS_OWN = ['HEALTHY', 'PROBATION', 'SHUTDOWN'] as const
const AWS_MANAGED = ['ENABLED', 'REINSTATED', 'DISABLED'] as const

/** Amazon's verdict as recorded on a check row (null when that check could not read it). */
function awsOfCheck(row: ReputationCheckRow | undefined): AwsReputation {
  if (!row?.awsStatus) return null
  if (row.mode === 'own' && (AWS_OWN as readonly string[]).includes(row.awsStatus)) {
    return {
      mode: 'own',
      enforcement: row.awsStatus as (typeof AWS_OWN)[number],
      sendingEnabled: row.awsSendingEnabled !== false,
    }
  }
  if (row.mode === 'managed' && (AWS_MANAGED as readonly string[]).includes(row.awsStatus)) {
    return { mode: 'managed', sendingStatus: row.awsStatus as (typeof AWS_MANAGED)[number] }
  }
  throw new Error(
    `mail_reputation_checks ${row.id}: unknown Amazon status "${row.awsStatus}" for mode ${row.mode}`,
  )
}

export class ReputationService {
  private gateCache: { at: number; state: ReputationState } | null = null

  constructor(private readonly deps: ReputationServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /** The current picture, with Amazon's last recorded verdict (no AWS call). */
  async view(): Promise<ReputationView> {
    const [latest] = await this.deps.store.listReputationChecks(1)
    return this.evaluate(
      awsOfCheck(latest),
      latest ? { at: latest.checkedAt, awsError: latest.awsError } : null,
    )
  }

  private async evaluate(
    aws: AwsReputation,
    lastCheck: ReputationView['lastCheck'],
  ): Promise<ReputationView> {
    const settings = await this.deps.owlery.settings()
    const [reset] = await this.deps.store.listReputationResets(1)
    const windowStart = new Date(
      this.now().getTime() - REPUTATION_WINDOW.days * 24 * 60 * 60 * 1000,
    )
    const since = reset && reset.createdAt > windowStart ? reset.createdAt : windowStart
    const rows = await this.deps.store.reputationWindow(since, REPUTATION_WINDOW.mails)
    const tracking =
      settings !== null &&
      (settings.eventsStatus === 'ready' || settings.eventsStatus === 'waiting')
    // A verdict from the other mode (the owner switched to their own SES) says nothing about this account.
    const sameMode = aws && settings && aws.mode === settings.mode ? aws : null
    const state = evaluateReputation(rows, sameMode, { tracking })
    return { ...state, mode: settings?.mode ?? null, since, lastCheck }
  }

  /** Amazon's verdict right now: GetAccount (own SES) or GetTenant (eigenEnterprise Mail). */
  private async readAws(): Promise<{ aws: AwsReputation; error: string | null }> {
    const settings = await this.deps.owlery.settings()
    if (!settings) return { aws: null, error: null }
    try {
      const { ses } = await this.deps.owlery.ses()
      if (settings.mode === 'managed') {
        if (!settings.tenant) throw new Error('eigenEnterprise Mail has no tenant configured')
        return {
          aws: {
            mode: 'managed',
            sendingStatus: await ses.getTenantSendingStatus(settings.tenant),
          },
          error: null,
        }
      }
      const a = await ses.accountReputation()
      return {
        aws: { mode: 'own', enforcement: a.enforcement, sendingEnabled: a.sendingEnabled },
        error: null,
      }
    } catch (err) {
      return { aws: null, error: describeSesError(err) }
    }
  }

  /**
   * Reads Amazon now and records the check (R7). When Amazon can't be read, the
   * error is recorded and the last verdict it gave still counts (a failed read
   * never lifts a hold Amazon put on the account).
   */
  async check(): Promise<ReputationView> {
    const settings = await this.deps.owlery.settings()
    const read = await this.readAws()
    const [latest] = await this.deps.store.listReputationChecks(1)
    const aws = read.aws ?? (read.error ? awsOfCheck(latest) : null)
    const at = this.now()
    const view = await this.evaluate(aws, { at, awsError: read.error })
    await this.deps.store.insertReputationCheck({
      band: view.band,
      recipients: view.rates.recipients,
      bounces: view.rates.bounces,
      complaints: view.rates.complaints,
      bounceRate: view.rates.bounceRate,
      complaintRate: view.rates.complaintRate,
      awsStatus: aws ? (aws.mode === 'own' ? aws.enforcement : aws.sendingStatus) : null,
      awsSendingEnabled: aws?.mode === 'own' ? aws.sendingEnabled : null,
      mode: settings?.mode ?? 'own',
      awsError: read.error,
      reasons: view.reasons,
      slices: view.slices.map((s) => ({ ...s })),
      checkedAt: at,
    })
    this.gateCache = null
    return view
  }

  /** The tick: a check once an hour while mail is set up. */
  async checkIfDue(): Promise<boolean> {
    if (!(await this.deps.owlery.settings())) return false
    const [latest] = await this.deps.store.listReputationChecks(1)
    if (latest && this.now().getTime() - latest.checkedAt.getTime() < REPUTATION_CHECK_EVERY_MS)
      return false
    await this.check()
    return true
  }

  /** Why this mail may not go out now, or null (R5). Cached for a minute. */
  async refusal(send: SendSlice): Promise<string | null> {
    const at = this.now().getTime()
    if (!this.gateCache || at - this.gateCache.at > GATE_CACHE_MS)
      this.gateCache = { at, state: await this.view() }
    return reputationRefusal(this.gateCache.state, send)
  }

  /**
   * An admin resumes sending after cleaning the list (R6): the window restarts
   * now. Refused while Amazon itself holds the account, and when nothing is held.
   */
  async resume(
    by: string,
    reason: string,
  ): Promise<{ view: ReputationView; reset: ReputationResetRow }> {
    const why = reason.trim()
    if (!why)
      throw new ReputationError(
        'Say what was fixed (for example: "removed the bought list"). It is kept with the resume.',
      )
    const before = await this.check()
    const aws = before.aws
    if (
      aws &&
      ((aws.mode === 'own' && (aws.enforcement !== 'HEALTHY' || !aws.sendingEnabled)) ||
        (aws.mode === 'managed' && aws.sendingStatus === 'DISABLED'))
    ) {
      throw new ReputationError(
        `Amazon itself holds this account (${aws.mode === 'own' ? aws.enforcement : aws.sendingStatus}${aws.mode === 'own' && !aws.sendingEnabled ? ', sending switched off' : ''}). That is lifted at Amazon${aws.mode === 'managed' ? ' (contact support)' : ' (SES console › Reputation)'}, not here.`,
      )
    }
    if (!before.sendingHeld && !before.slices.some((s) => s.band === 'held')) {
      throw new ReputationError('Nothing is on hold: mail is going out.')
    }
    const reset = await this.deps.store.insertReputationReset({
      resetBy: by,
      reason: why,
      band: before.band,
      recipients: before.rates.recipients,
      bounceRate: before.rates.bounceRate,
      complaintRate: before.rates.complaintRate,
      createdAt: this.now(),
    })
    this.gateCache = null
    return { view: await this.check(), reset }
  }

  async history(
    limit = 48,
  ): Promise<{ checks: ReputationCheckRow[]; resets: ReputationResetRow[] }> {
    const [checks, resets] = await Promise.all([
      this.deps.store.listReputationChecks(limit),
      this.deps.store.listReputationResets(20),
    ])
    return { checks, resets }
  }
}

/** The reputation as the tools and the Reputation tab show it (numbers, Amazon's verdict, flagged slices; no addresses but senders). */
export function reputationOut(v: ReputationView) {
  return {
    band: v.band,
    sendingHeld: v.sendingHeld,
    tracking: v.tracking,
    mode: v.mode,
    since: v.since.toISOString(),
    rates: v.rates,
    reasons: v.reasons,
    amazon: v.aws,
    lastCheck: v.lastCheck
      ? { at: v.lastCheck.at.toISOString(), amazonError: v.lastCheck.awsError }
      : null,
    slices: v.slices.map((s) => ({
      dimension: s.dimension,
      value: s.value,
      label: sliceLabel(s.dimension, s.value),
      band: s.band,
      recipients: s.recipients,
      bounces: s.bounces,
      complaints: s.complaints,
      bounceRate: s.bounceRate,
      complaintRate: s.complaintRate,
      reasons: s.reasons,
    })),
  }
}
