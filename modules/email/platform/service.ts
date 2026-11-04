import { resolveTxt } from 'node:dns/promises'
import { z } from 'zod'
import type { DbHandle } from '$lib/kernel/db-stores'
import { env } from '$lib/server/env/private-env'
import { MailSetupError } from '$lib/server/mail/company-mail'
import { owleryService, SEND_SCHEDULED_JOB, type OwleryService } from '../owlery/service'
import { describeSesError } from '../owlery/ses'
import {
  DKIM_SELECTOR,
  dnsRecords,
  generateDkimKeyPair,
  mailFromDomain,
  normalizeDomain,
  registrableDomain,
  type DnsRecord,
} from './dns'
import { AudienceService, FLOW_STEP_JOB } from './flows/service'
import { isRepeatableEngagement, parseSesEvent, type ParsedSesEvent } from './ses-events'
import { isSnsUrl, type SnsMessage } from './sns-signature'
import { nextStatus, type MessageStatus } from './status'
import { defaultEmailStore, type DomainRow, type EmailStore, type JobRow, type MessageRow } from './store'
import { normalizeEmail } from './suppression'
import { emailBrandFromCssVars, type EmailBrand } from './templates/brand'
import { TemplateService } from './templates/service'
import { applyIdentityCheck, dueForCheck } from './verification'

/**
 * The email platform (plan/phase-polish-1.md P-6): sender domains, senders,
 * the sent-mail log, suppressions, SES delivery events and the module's
 * background work. Sending itself stays in OwleryService.send — the one send
 * path; this service only adds what surrounds it.
 */

export type DomainView = DomainRow & { records: DnsRecord[]; sendable: boolean }

/** Thrown for anything the owner did wrong or must do first; the message is shown as is. */
export class EmailPlatformError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailPlatformError'
  }
}

export type JobHandler = (job: JobRow) => Promise<void>

export type EmailPlatformDeps = {
  owlery: OwleryService
  store: EmailStore
  /** DNS TXT lookup for the DMARC check (node:dns in the app). */
  resolveTxt: (name: string) => Promise<string[][]>
  /** GET a URL (SNS SubscribeURL confirmation). */
  fetch: typeof fetch
  /** The company's Brand as email tokens (layouts and templates). */
  brand: () => Promise<EmailBrand>
  /** The database for contacts and flows (stage 3). */
  db: DbHandle
  /** This server's public https origin, for unsubscribe and confirm links. */
  origin: () => string
  now?: () => Date
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/

export class EmailPlatform {
  /** Extra job kinds (stage 3 flows) register here. */
  private readonly handlers = new Map<string, JobHandler>()
  /** Called after every applied SES event (stage 3: contacts unsubscribe on hard bounce/complaint). */
  private readonly eventListeners: ((e: ParsedSesEvent, message: MessageRow) => Promise<void>)[] = []

  /** Templates and layouts (stage 2). */
  readonly templates: TemplateService
  /** Contact lists and flows (stage 3). */
  readonly audience: AudienceService

  constructor(private readonly deps: EmailPlatformDeps) {
    this.templates = new TemplateService({ store: deps.store, owlery: deps.owlery, brand: deps.brand })
    this.audience = new AudienceService({
      db: deps.db,
      owlery: deps.owlery,
      templates: this.templates,
      enqueue: (kind, payload, runAt, dedupeKey) => deps.store.enqueueJob(kind, payload, runAt, dedupeKey),
      origin: deps.origin,
      ...(deps.now ? { now: deps.now } : {}),
    })
    this.handlers.set(FLOW_STEP_JOB, (job) => this.audience.runJob(job))
    // A hard bounce or a spam complaint also unsubscribes the address from every list.
    this.eventListeners.push(async (e) => {
      for (const s of e.suppress) {
        await this.audience.unsubscribeEverywhere(s.email, s.reason === 'COMPLAINT' ? 'COMPLAINED' : 'BOUNCED')
      }
    })
    this.handlers.set(SEND_SCHEDULED_JOB, async (job) => {
      const id = job.payload.messageId
      if (typeof id !== 'string') throw new Error('send_scheduled job without messageId')
      await this.deps.owlery.sendScheduled(id)
    })
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  registerJob(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler)
  }

  onSesEvent(listener: (e: ParsedSesEvent, message: MessageRow) => Promise<void>): void {
    this.eventListeners.push(listener)
  }

  get store(): EmailStore {
    return this.deps.store
  }

  get owlery(): OwleryService {
    return this.deps.owlery
  }

  // ─── domains ───────────────────────────────────────────────────────────────

  private view(d: DomainRow): DomainView {
    return { ...d, records: dnsRecords(d), sendable: d.status === 'SUCCESS' }
  }

  async listDomains(): Promise<DomainView[]> {
    return (await this.deps.store.listDomains()).map((d) => this.view(d))
  }

  async getDomain(id: string): Promise<DomainView | null> {
    const d = await this.deps.store.getDomain(id)
    return d ? this.view(d) : null
  }

  /** Registers the domain at Amazon with our own DKIM key and its MAIL FROM subdomain. */
  async addDomain(input: string, createdBy: string): Promise<DomainView> {
    let name: string
    try {
      name = normalizeDomain(input)
    } catch (err) {
      throw new EmailPlatformError((err as Error).message)
    }
    if (await this.deps.store.getDomainByName(name)) throw new EmailPlatformError(`${name} is already added.`)
    const { ses, settings } = await this.deps.owlery.ses()
    const keys = generateDkimKeyPair()
    try {
      await ses.createDomainIdentity({
        domain: name,
        dkimSelector: DKIM_SELECTOR,
        dkimPrivateKey: keys.privateKey,
        mailFromDomain: mailFromDomain(name),
      })
    } catch (err) {
      throw new EmailPlatformError(describeSesError(err))
    }
    const row = await this.deps.store.insertDomain({
      name,
      region: settings.region,
      status: 'PENDING',
      dkimSelector: DKIM_SELECTOR,
      publicKey: keys.publicKey,
      dkimStatus: 'PENDING',
      mailFromStatus: 'PENDING',
      isVerifying: true,
      createdBy,
    })
    return this.view(row)
  }

  private async dmarcFound(domain: string): Promise<boolean> {
    try {
      const txt = await this.deps.resolveTxt(`_dmarc.${registrableDomain(domain)}`)
      return txt.some((parts) => parts.join('').toUpperCase().startsWith('V=DMARC1'))
    } catch {
      // NXDOMAIN / no TXT: no DMARC record (yet).
      return false
    }
  }

  /** Reads Amazon's verification state (+ our DMARC lookup) and stores the next state. */
  async refreshDomain(id: string): Promise<DomainView> {
    const d = await this.deps.store.getDomain(id)
    if (!d) throw new EmailPlatformError('That domain does not exist (any more).')
    const { ses } = await this.deps.owlery.ses()
    let check
    try {
      check = await ses.getDomainIdentity(d.name)
    } catch (err) {
      throw new EmailPlatformError(describeSesError(err))
    }
    const next = applyIdentityCheck(check, await this.dmarcFound(d.name), this.now())
    return this.view(await this.deps.store.updateDomain(id, next))
  }

  /** "Re-check": restarts the background checks for a failed domain too. */
  async recheckDomain(id: string): Promise<DomainView> {
    await this.deps.store.updateDomain(id, { isVerifying: true })
    return this.refreshDomain(id)
  }

  async setDomainTracking(id: string, tracking: boolean): Promise<DomainView> {
    return this.view(await this.deps.store.updateDomain(id, { tracking }))
  }

  async deleteDomain(id: string): Promise<void> {
    const d = await this.deps.store.getDomain(id)
    if (!d) return
    const { ses, settings } = await this.deps.owlery.ses()
    if (settings.emailFrom.toLowerCase().endsWith(`@${d.name}`)) {
      throw new EmailPlatformError(
        `${settings.emailFrom} is your default sender (it sends sign-in codes). Make another sender the default first.`,
      )
    }
    try {
      await ses.deleteIdentity(d.name)
    } catch (err) {
      throw new EmailPlatformError(describeSesError(err))
    }
    await this.deps.store.deleteDomain(id)
  }

  // ─── senders ───────────────────────────────────────────────────────────────

  async listSenders() {
    const { settings } = await this.deps.owlery.ses()
    const rows = await this.deps.store.listSenders()
    const def = settings.emailFrom.toLowerCase()
    const list = rows.map((r) => ({ ...r, isDefault: r.address === def }))
    // The default sender saved during setup is always listed, even before it has a row.
    if (!list.some((r) => r.isDefault)) {
      list.unshift({
        id: '',
        address: def,
        displayName: null,
        domainId: null,
        createdBy: 'setup',
        createdAt: new Date(0),
        domainName: null,
        domainStatus: null,
        isDefault: true,
      })
    }
    return list
  }

  /** A named from-address on a verified domain (or an address Amazon verified on its own). */
  async addSender(input: { address: string; displayName: string | null }, createdBy: string) {
    const address = normalizeEmail(input.address)
    if (!ADDRESS.test(address)) throw new EmailPlatformError('Enter a plain email address, like hello@yourcompany.com.')
    const domainName = address.slice(address.lastIndexOf('@') + 1)
    const domain = await this.deps.store.getDomainByName(domainName)
    const displayName = input.displayName?.trim() || null
    if (domain) {
      if (domain.status !== 'SUCCESS') {
        throw new EmailPlatformError(`${domainName} is not verified yet. Finish its DNS records first, then add the sender.`)
      }
      return this.deps.store.upsertSender({ address, displayName, domainId: domain.id, createdBy })
    }
    if (!(await this.deps.owlery.senderVerified(address))) {
      throw new EmailPlatformError(`Add ${domainName} under Domains and verify it first, then add ${address} here.`)
    }
    return this.deps.store.upsertSender({ address, displayName, domainId: null, createdBy })
  }

  async deleteSender(id: string): Promise<void> {
    const sender = await this.deps.store.getSender(id)
    if (!sender) return
    const { settings } = await this.deps.owlery.ses()
    if (sender.address === settings.emailFrom.toLowerCase()) {
      throw new EmailPlatformError('This is the default sender. Make another sender the default first.')
    }
    await this.deps.store.deleteSender(id)
  }

  async setDefaultSender(id: string, updatedBy: string): Promise<void> {
    const sender = await this.deps.store.getSender(id)
    if (!sender) throw new EmailPlatformError('That sender does not exist (any more).')
    const check = await this.deps.store.checkSender(sender.address)
    if (!check.ok) throw new EmailPlatformError(check.reason)
    // The setup's default sender has no row yet: keep it listed after the switch.
    const { settings } = await this.deps.owlery.ses()
    const previous = settings.emailFrom.toLowerCase()
    if (previous !== sender.address && !(await this.deps.store.getSenderByAddress(previous))) {
      const domain = await this.deps.store.getDomainByName(previous.slice(previous.lastIndexOf('@') + 1))
      await this.deps.store.upsertSender({ address: previous, displayName: null, domainId: domain?.id ?? null, createdBy: 'setup' })
    }
    await this.deps.owlery.setDefaultSender(sender.address, updatedBy)
  }

  // ─── suppressions ──────────────────────────────────────────────────────────

  async suppress(email: string, by: string) {
    const address = normalizeEmail(email)
    if (!ADDRESS.test(address)) throw new EmailPlatformError('Enter a plain email address.')
    return this.deps.store.addSuppression(address, 'MANUAL', `human:${by}`)
  }

  /** Removes it here and from Amazon's own account-level list (both, or a plain error). */
  async unsuppress(email: string): Promise<void> {
    const address = normalizeEmail(email)
    const { ses } = await this.deps.owlery.ses()
    try {
      await ses.removeFromAccountSuppression(address)
    } catch (err) {
      throw new EmailPlatformError(`Amazon still blocks ${address}: ${describeSesError(err)}`)
    }
    await this.deps.store.removeSuppression(address)
  }

  /** Cancels a scheduled send before its job runs. */
  async cancelScheduled(messageId: string): Promise<void> {
    const m = await this.deps.store.getMessage(messageId)
    if (!m) throw new EmailPlatformError('That mail does not exist (any more).')
    if (m.status !== 'scheduled') throw new EmailPlatformError('Only a scheduled mail can be cancelled; this one was already handled.')
    await this.deps.store.cancelJobs(`send:${m.id}`)
    await this.deps.store.updateMessage(m.id, { status: 'cancelled' })
    await this.deps.store.addEvent(m.id, 'cancelled', null)
  }

  // ─── SES delivery events ───────────────────────────────────────────────────

  /**
   * Applies one SES event to the log: the status only moves forward, the
   * timeline gets the event (first open/click only), permanent bounces and
   * complaints suppress the recipient. Unknown messages (another install
   * sharing the topic) are ignored.
   */
  async applySesEvent(raw: unknown): Promise<{ applied: boolean }> {
    const e = parseSesEvent(raw)
    if (!e) return { applied: false }
    let message = await this.deps.store.findMessageBySesId(e.sesMessageId)
    if (!message && e.logId) {
      message = await this.deps.store.getMessage(e.logId)
      if (message && !message.sesMessageId) {
        message = await this.deps.store.updateMessage(message.id, { sesMessageId: e.sesMessageId })
      }
    }
    if (!message) return { applied: false }

    if (isRepeatableEngagement(e.status) && (await this.deps.store.hasEvent(message.id, e.status))) {
      return { applied: true }
    }
    const status = nextStatus(message.status as MessageStatus, e.status)
    if (status !== message.status) message = await this.deps.store.updateMessage(message.id, { status })
    await this.deps.store.addEvent(message.id, e.status, e.detail, e.occurredAt)
    for (const s of e.suppress) await this.deps.store.addSuppression(s.email, s.reason, message.id)
    for (const listener of this.eventListeners) await listener(e, message)
    return { applied: true }
  }

  /**
   * A verified SNS message for our topic: confirm the subscription, record an
   * unsubscribe, or apply the SES event inside a notification.
   */
  async handleSnsMessage(m: SnsMessage): Promise<{ status: number; body: Record<string, unknown> }> {
    const settings = await this.deps.owlery.settings()
    if (!settings?.eventsTopicArn || settings.eventsTopicArn !== m.TopicArn) {
      return { status: 403, body: { error: 'This SNS topic does not belong to this company.' } }
    }
    if (m.Type === 'SubscriptionConfirmation') {
      if (!m.SubscribeURL || !isSnsUrl(m.SubscribeURL)) return { status: 400, body: { error: 'SubscribeURL is not an SNS address.' } }
      const res = await this.deps.fetch(m.SubscribeURL, { redirect: 'error' })
      if (!res.ok) {
        await this.deps.owlery.markEvents({ eventsStatus: 'failed', eventsError: `Amazon SNS refused the confirmation (HTTP ${res.status}).` })
        return { status: 502, body: { error: 'confirmation failed' } }
      }
      await this.deps.owlery.markEvents({ eventsStatus: 'ready', eventsError: null })
      return { status: 200, body: { ok: true, confirmed: true } }
    }
    if (m.Type === 'UnsubscribeConfirmation') {
      await this.deps.owlery.markEvents({
        eventsStatus: 'failed',
        eventsError: 'The SNS subscription was removed at Amazon. Press "Set up again".',
      })
      return { status: 200, body: { ok: true } }
    }
    let event: unknown
    try {
      event = JSON.parse(m.Message)
    } catch {
      return { status: 400, body: { error: 'The notification is not an SES event.' } }
    }
    try {
      const out = await this.applySesEvent(event)
      return { status: 200, body: { ok: true, applied: out.applied } }
    } catch (err) {
      if (err instanceof Error && err.name === 'ZodError') return { status: 400, body: { error: 'The notification is not an SES event.' } }
      throw err
    }
  }

  // ─── background work (the global job-queue tick) ──────────────────────────

  /** Re-checks domains still waiting on DNS (cadence: verification.dueForCheck). */
  async refreshDueDomains(): Promise<number> {
    if (!(await this.deps.owlery.isConfigured())) return 0
    const now = this.now()
    let n = 0
    for (const d of await this.deps.store.verifyingDomains()) {
      if (!dueForCheck(d, now)) continue
      try {
        await this.refreshDomain(d.id)
        n += 1
      } catch (err) {
        console.error('[email] domain re-check failed', { domain: d.name, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return n
  }

  async runJobs(limit = 20): Promise<{ done: number; failed: number }> {
    let done = 0
    let failed = 0
    for (const job of await this.deps.store.claimDueJobs(limit, this.now())) {
      const handler = this.handlers.get(job.kind)
      try {
        if (!handler) throw new Error(`no handler for email job kind "${job.kind}"`)
        await handler(job)
        await this.deps.store.finishJob(job.id)
        done += 1
      } catch (err) {
        const message = err instanceof MailSetupError ? err.message : err instanceof Error ? err.message : String(err)
        console.error('[email] job failed', { kind: job.kind, id: job.id, attempt: job.attempts, error: message })
        await this.deps.store.failJob(job, message, this.now())
        failed += 1
      }
    }
    return { done, failed }
  }

  /** One pass of the module's background work. */
  async tick(): Promise<{ domains: number; jobs: { done: number; failed: number } }> {
    const domains = await this.refreshDueDomains()
    const jobs = await this.runJobs()
    return { domains, jobs }
  }
}

const visualSetList = z.array(z.object({ status: z.string(), cssVars: z.record(z.string(), z.string()) }).passthrough())

/** The email module's own principal for the kernel reads it makes off-request (brand tokens). */
const EMAIL_SERVICE_CTX = {
  principal: { id: 'service:email', kind: 'service' as const, roles: ['agent'] },
  requestId: 'email-platform',
}

const host = globalThis as { __eeEmailPlatform?: EmailPlatform }

/** The process-wide email platform over the Owlery service and the Postgres store. */
export function emailPlatform(): EmailPlatform {
  if (!host.__eeEmailPlatform) {
    const platform = new EmailPlatform({
      owlery: owleryService(),
      store: defaultEmailStore(),
      resolveTxt,
      fetch,
      db: async () => {
        const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
        return appDbAsyncLocal.getStore() ?? createScopedDrizzle(appSql)
      },
      origin: () => {
        const origin = env.ORIGIN?.trim()
        if (!origin) throw new Error('ORIGIN is not set: email links (unsubscribe, confirm) need the public address of this server')
        return origin.replace(/\/+$/, '')
      },
      brand: async () => {
        const [{ appKernel }, { foundingCompanyName }] = await Promise.all([
          import('$lib/server/boot'),
          import('$lib/server/overview/sources'),
        ])
        const kernel = await appKernel()
        // The brand module owns the visual sets; email reads them through the kernel (module boundary).
        // A switched-off brand module means no brand style is active for the company.
        let cssVars: Record<string, string> | null = null
        if ((await kernel.activations.get('brand')) === true) {
          const sets = visualSetList.parse(await kernel.registry.execute('brand.visual_set_list', {}, EMAIL_SERVICE_CTX))
          cssVars = sets.find((set) => set.status === 'active')?.cssVars ?? null
        }
        return emailBrandFromCssVars(cssVars, await foundingCompanyName())
      },
    })
    host.__eeEmailPlatform = platform
  }
  return host.__eeEmailPlatform
}
