import { z } from 'zod'
import { env } from '$lib/server/env/private-env'
import {
  MailNotConfiguredError,
  MailSetupError,
  SenderNotVerifiedError,
  type CompanyMail,
  type SaveMailSettingsInput,
  type SendMailInput,
  type SendMailResult,
} from '$lib/server/mail/company-mail'
import { LOG_ID_TAG, WEBMAIL_TAG } from '../platform/ses-events'
import { defaultEmailStore, type EmailStore, type MessageRow } from '../platform/store'
import { defaultFakeMailStore, fakeSns, fakeStoreSes } from './fake-store'
import { awsErrorCode, awsSes, describeSesError, type SesApi, type SesRawSendInput, type SesCredentials, type SesEventType, type SesFactory } from './ses'
import { awsSns, EventsSetupError, type SnsApi, type SnsFactory } from './sns'
import { defaultOwleryStore, owlerySealKey, sealSecret, unsealSecret, type OwleryEvents, type OwleryStore } from './store'
import { resolveMailTransport, type MailTransport } from './transport'

export type OwlerySettings = SesCredentials & { emailFrom: string } & OwleryEvents

export type OwleryStatus =
  | { configured: false }
  | { configured: true; region: string; sender: string; senderVerified: boolean; sandbox: boolean }

/** The slice of the email store the one send path needs (sender check, suppression, the log, jobs). */
export type MailLog = Pick<
  EmailStore,
  'checkSender' | 'isSuppressed' | 'insertMessage' | 'updateMessage' | 'getMessage' | 'addEvent' | 'enqueueJob'
>

export type OwleryServiceDeps = {
  store: OwleryStore
  key: () => Buffer
  log: MailLog
  ses?: SesFactory
  sns?: SnsFactory
  now?: () => number
}

/** The background job that sends a scheduled message (EmailPlatform.runJobs). */
export const SEND_SCHEDULED_JOB = 'send_scheduled'

const CACHE_MS = 30_000

const settingsInput = z.object({
  region: z
    .string()
    .trim()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d+$/, 'The region looks wrong. It is written like eu-central-1 or us-east-1.'),
  accessKeyId: z.string().trim().min(1, 'The access key ID is required.'),
  secretAccessKey: z.string().trim().min(1, 'The secret access key is required.'),
  emailFrom: z.email('The sender must be a plain email address, like hello@yourcompany.com.').trim(),
  testRecipient: z.email('Your account has no valid email address to send the test email to.'),
  updatedBy: z.string().min(1),
})

const TEST_MAIL = {
  subject: 'Email works — Eigen Enterprise',
  text: 'This is the test email from your Eigen Enterprise setup. Sign-in codes and notifications will come from this address.',
  html: '<p>This is the test email from your Eigen Enterprise setup.</p><p>Sign-in codes and notifications will come from this address.</p>',
}

/** Delivery events every configuration set forwards; the tracking set adds opens and clicks. */
const GENERAL_EVENTS: SesEventType[] = ['SEND', 'REJECT', 'BOUNCE', 'COMPLAINT', 'DELIVERY', 'DELIVERY_DELAY', 'RENDERING_FAILURE']
const TRACKING_EVENTS: SesEventType[] = [...GENERAL_EVENTS, 'OPEN', 'CLICK']

/** Verified for sending either as an address or through its whole domain. */
async function identityState(ses: SesApi, address: string): Promise<'verified' | 'pending' | 'missing'> {
  const own = await ses.getIdentity(address)
  if (own.verified) return 'verified'
  const domain = address.slice(address.lastIndexOf('@') + 1)
  if ((await ses.getIdentity(domain)).verified) return 'verified'
  return own.exists ? 'pending' : 'missing'
}

function sandboxMessage(recipient: string): string {
  return (
    `Your Amazon SES account is still in the sandbox, so it can only send to addresses Amazon has verified. ` +
    `Amazon sent a verification email to ${recipient} — click the link inside, then try again. ` +
    `To send to anyone, request production access in the Amazon SES console.`
  )
}

/** `"Display Name" <address>` (quotes and backslashes escaped), or the bare address. */
export function formatFrom(address: string, displayName: string | null): string {
  if (!displayName?.trim()) return address
  const name = displayName.trim().replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\r\n]/g, ' ')
  return `"${name}" <${address}>`
}

/** A mailbox's mail (the webmail, plan/email-inbox.md S5), built as raw MIME by the inbox. */
export type MailboxSendInput = {
  /** The mailbox address the mail goes out From. */
  fromAddress: string
  /** The envelope: every address the mail is delivered to (Bcc only here, never in the raw headers). */
  recipients: SesRawSendInput['recipients']
  raw: Uint8Array
}

export const WEBMAIL_SANDBOX_MESSAGE =
  'Amazon SES is still in its sandbox, so it only delivers to verified addresses. Request production access in the AWS console.'

function suppressedMessage(addresses: string[]): string {
  const list = addresses.join(', ')
  return addresses.length === 1
    ? `${list} is on the company’s suppression list (an earlier mail bounced or was marked as spam), so nothing is sent to it. Remove it from the To, Cc or Bcc and send again, or ask the owner or an admin to check Email › Suppression.`
    : `${list} are on the company’s suppression list (earlier mail bounced or was marked as spam), so nothing is sent to them. Remove them from the To, Cc or Bcc and send again, or ask the owner or an admin to check Email › Suppression.`
}

/** Names AWS accepts for topics (256) and configuration sets (64): ee-<host>… */
export function eventResourceNames(origin: string): { topic: string; configSet: string; trackingConfigSet: string } {
  const host = new URL(origin).hostname.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
  return { topic: `ee-${host}-mail-events`, configSet: `ee-${host}`, trackingConfigSet: `ee-${host}-tracking` }
}

/**
 * Owns the SES settings and every send — the one send path. Every mail is
 * checked against the senders and the suppression list and written to the
 * sent-mail log before it goes to Amazon. The process singleton is `owleryService()`.
 */
export class OwleryService implements CompanyMail {
  private cache: { at: number; value: OwlerySettings | null } | null = null
  private readonly sesFactory: SesFactory
  private readonly snsFactory: SnsFactory

  constructor(private readonly deps: OwleryServiceDeps) {
    this.sesFactory = deps.ses ?? awsSes
    this.snsFactory = deps.sns ?? awsSns
  }

  async settings(): Promise<OwlerySettings | null> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value
    const row = await this.deps.store.read()
    const value = row
      ? {
          region: row.region,
          accessKeyId: row.accessKeyId,
          secretAccessKey: unsealSecret(row.sealedSecretAccessKey, this.deps.key()),
          emailFrom: row.emailFrom,
          eventsStatus: row.eventsStatus,
          eventsError: row.eventsError,
          eventsTopicArn: row.eventsTopicArn,
          eventsCallbackUrl: row.eventsCallbackUrl,
          configSet: row.configSet,
          trackingConfigSet: row.trackingConfigSet,
        }
      : null
    this.cache = { at: now, value }
    return value
  }

  /** Deletes the stored settings (the e2e harness reset under MAIL_TRANSPORT=fake). */
  async forgetSettings(): Promise<void> {
    await this.deps.store.clear()
    this.cache = null
  }

  async isConfigured(): Promise<boolean> {
    return (await this.settings()) !== null
  }

  private client(s: SesCredentials): SesApi {
    return this.sesFactory({ region: s.region, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey })
  }

  /** The SES client for the saved account. Throws MailNotConfiguredError before setup. */
  async ses(): Promise<{ ses: SesApi; settings: OwlerySettings }> {
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    return { ses: this.client(s), settings: s }
  }

  private async sns(): Promise<{ sns: SnsApi; settings: OwlerySettings }> {
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    return { sns: this.snsFactory(s), settings: s }
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    const source = input.source ?? 'system'
    const fromAddress = (input.from ?? s.emailFrom).trim().toLowerCase()

    const check = await this.deps.log.checkSender(fromAddress)
    // The default sender passed Amazon's own check when it was saved.
    if (!check.ok && fromAddress !== s.emailFrom.toLowerCase()) throw new MailSetupError(check.reason)
    const from = formatFrom(fromAddress, check.ok ? check.displayName : null)
    const tracking = check.ok && check.tracking

    const scheduled = input.scheduledAt && input.scheduledAt.getTime() > (this.deps.now?.() ?? Date.now())
    const suppressed = await this.deps.log.isSuppressed(input.to)
    // A scheduled send must keep its body until the job sends it; system mail never schedules.
    const contentStored = source !== 'system' || Boolean(scheduled)
    const row = await this.deps.log.insertMessage({
      source,
      status: suppressed ? 'suppressed' : scheduled ? 'scheduled' : 'queued',
      fromAddress,
      toAddress: input.to,
      replyTo: input.replyTo ?? null,
      subject: input.subject,
      html: contentStored ? input.html : null,
      text: contentStored ? input.text : null,
      contentStored,
      headers: input.headers ?? null,
      apiKeyId: input.apiKey?.id ?? null,
      apiKeyName: input.apiKey?.name ?? null,
      templateId: input.templateId ?? null,
      contactId: input.contactId ?? null,
      flowId: input.flowId ?? null,
      scheduledAt: input.scheduledAt ?? null,
    })

    if (suppressed) {
      await this.deps.log.addEvent(row.id, 'suppressed', { reason: 'The recipient is on the suppression list.' })
      return { id: row.id, status: 'suppressed', messageId: null }
    }
    if (scheduled) {
      await this.deps.log.addEvent(row.id, 'scheduled', { at: input.scheduledAt!.toISOString() })
      await this.deps.log.enqueueJob(SEND_SCHEDULED_JOB, { messageId: row.id }, input.scheduledAt!, `send:${row.id}`)
      return { id: row.id, status: 'scheduled', messageId: null }
    }
    await this.deps.log.addEvent(row.id, 'queued', null)
    const messageId = await this.deliver(s, row, { from, html: input.html, text: input.text, tracking })
    return { id: row.id, status: 'sent', messageId }
  }

  /**
   * A mailbox's mail (the webmail): the same sender check and suppression list
   * as every send, but **no sent-mail log row** — a personal mailbox is read
   * only by its member, a shared one only by its group (owner decision
   * 2026-11-12), so neither subject, recipients nor body reach `mail_messages`
   * or Logs. The general configuration set routes its events; the
   * WEBMAIL_TAG (value "1", no ids) lets the event handler recognise them and
   * still suppress bounced and complaining addresses. No open/click tracking.
   * A suppressed recipient refuses the whole mail (never silently dropped).
   */
  async sendMailboxMail(input: MailboxSendInput): Promise<{ sesMessageId: string }> {
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    const fromAddress = input.fromAddress.trim().toLowerCase()
    const check = await this.deps.log.checkSender(fromAddress)
    if (!check.ok) {
      const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1)
      throw new MailSetupError(
        `Mail can’t go out from ${fromAddress} yet: its domain ${domain} isn’t verified at Amazon SES. The owner or an admin finishes its DNS records under Email › Domains.`,
      )
    }
    const all = [...input.recipients.to, ...input.recipients.cc, ...input.recipients.bcc]
    if (all.length === 0) throw new MailSetupError('Add at least one recipient.')
    const suppressed: string[] = []
    for (const r of all) if (await this.deps.log.isSuppressed(r)) suppressed.push(r)
    if (suppressed.length > 0) throw new MailSetupError(suppressedMessage(suppressed))

    const eventsWired = s.eventsStatus === 'ready' || s.eventsStatus === 'waiting'
    const configurationSet = eventsWired ? (s.configSet ?? undefined) : undefined
    const ses = this.client(s)
    let messageId: string | null
    try {
      ;({ messageId } = await ses.sendRaw({
        from: fromAddress,
        recipients: input.recipients,
        raw: input.raw,
        ...(configurationSet ? { configurationSet } : {}),
        tags: { [WEBMAIL_TAG]: '1' },
      }))
    } catch (err) {
      if (awsErrorCode(err) === 'MessageRejected') {
        // Which rejection it is comes from GetAccount (structured), never from Amazon's wording.
        let sandbox = false
        try {
          sandbox = await ses.isSandbox()
        } catch {
          // GetAccount failing too: Amazon's own reason for the rejection is the better message.
        }
        if (sandbox) throw new MailSetupError(WEBMAIL_SANDBOX_MESSAGE, { cause: err })
      }
      throw new MailSetupError(describeSesError(err), { cause: err })
    }
    if (!messageId) throw new Error('Amazon SES accepted the mail but returned no message id')
    return { sesMessageId: messageId }
  }

  /**
   * The background job's half of a scheduled send. A cancelled or already-sent
   * message is left alone; one whose last attempt failed is retried (the job
   * retries with backoff, the timeline shows each attempt).
   */
  async sendScheduled(messageId: string): Promise<void> {
    const row = await this.deps.log.getMessage(messageId)
    if (!row || !row.scheduledAt || (row.status !== 'scheduled' && row.status !== 'failed')) return
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    if (await this.deps.log.isSuppressed(row.toAddress)) {
      await this.deps.log.updateMessage(row.id, { status: 'suppressed' })
      await this.deps.log.addEvent(row.id, 'suppressed', { reason: 'The recipient is on the suppression list.' })
      return
    }
    if (row.html === null || row.text === null) throw new Error(`scheduled message ${row.id} has no stored body`)
    const check = await this.deps.log.checkSender(row.fromAddress)
    if (!check.ok && row.fromAddress !== s.emailFrom.toLowerCase()) {
      await this.deps.log.updateMessage(row.id, { status: 'failed', error: check.reason })
      await this.deps.log.addEvent(row.id, 'failed', { error: check.reason })
      return
    }
    await this.deps.log.updateMessage(row.id, { status: 'queued' })
    await this.deps.log.addEvent(row.id, 'queued', null)
    await this.deliver(s, row, {
      from: formatFrom(row.fromAddress, check.ok ? check.displayName : null),
      html: row.html,
      text: row.text,
      tracking: check.ok && check.tracking,
    })
  }

  /** Hands one logged message to Amazon and records the outcome on its timeline. */
  private async deliver(
    s: OwlerySettings,
    row: MessageRow,
    body: { from: string; html: string; text: string; tracking: boolean },
  ): Promise<string | null> {
    const eventsWired = s.eventsStatus === 'ready' || s.eventsStatus === 'waiting'
    const configurationSet = eventsWired ? ((body.tracking ? s.trackingConfigSet : s.configSet) ?? undefined) : undefined
    try {
      const { messageId } = await this.client(s).send({
        from: body.from,
        to: row.toAddress,
        subject: row.subject,
        html: body.html,
        text: body.text,
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        ...(configurationSet ? { configurationSet } : {}),
        ...(row.headers && row.headers.length > 0 ? { headers: row.headers } : {}),
        tags: { [LOG_ID_TAG]: row.id },
      })
      await this.deps.log.updateMessage(row.id, { status: 'sent', sesMessageId: messageId })
      await this.deps.log.addEvent(row.id, 'sent', null)
      return messageId
    } catch (err) {
      const message = describeSesError(err)
      await this.deps.log.updateMessage(row.id, { status: 'failed', error: message })
      await this.deps.log.addEvent(row.id, 'failed', { error: message })
      throw new MailSetupError(message, { cause: err })
    }
  }

  async status(): Promise<OwleryStatus> {
    const s = await this.settings()
    if (!s) return { configured: false }
    const ses = this.client(s)
    try {
      return {
        configured: true,
        region: s.region,
        sender: s.emailFrom,
        senderVerified: (await identityState(ses, s.emailFrom)) === 'verified',
        sandbox: await ses.isSandbox(),
      }
    } catch (err) {
      throw new MailSetupError(describeSesError(err), { cause: err })
    }
  }

  /** Whether Amazon accepts mail From this address right now (an address or its whole domain verified). */
  async senderVerified(address: string): Promise<boolean> {
    const { ses } = await this.ses()
    try {
      return (await identityState(ses, address)) === 'verified'
    } catch (err) {
      throw new MailSetupError(describeSesError(err), { cause: err })
    }
  }

  /** Makes another verified sender the default (system mail and sends without their own from). */
  async setDefaultSender(address: string, updatedBy: string): Promise<void> {
    await this.deps.store.writeEmailFrom(address.trim().toLowerCase(), updatedBy)
    this.cache = null
  }

  async saveVerified(input: SaveMailSettingsInput): Promise<void> {
    const parsed = settingsInput.safeParse(input)
    if (!parsed.success) throw new MailSetupError(parsed.error.issues[0]?.message ?? 'The email settings are incomplete.')
    const { region, accessKeyId, secretAccessKey, emailFrom, testRecipient, updatedBy } = parsed.data
    const ses = this.sesFactory({ region, accessKeyId, secretAccessKey })

    let sandbox = false
    try {
      // GetAccount first: it proves the keys and region before anything else.
      sandbox = await ses.isSandbox()
      const sender = await identityState(ses, emailFrom)
      if (sender === 'missing') await ses.createIdentity(emailFrom)
      if (sender !== 'verified') throw new SenderNotVerifiedError(emailFrom)
      if (sandbox) {
        const recipient = await identityState(ses, testRecipient)
        if (recipient === 'missing') await ses.createIdentity(testRecipient)
        if (recipient !== 'verified') throw new MailSetupError(sandboxMessage(testRecipient))
      }
      await ses.send({ from: emailFrom, to: testRecipient, ...TEST_MAIL })
    } catch (err) {
      if (err instanceof SenderNotVerifiedError || err instanceof MailSetupError) throw err
      if (sandbox && awsErrorCode(err) === 'MessageRejected') {
        throw new MailSetupError(sandboxMessage(testRecipient), { cause: err })
      }
      throw new MailSetupError(describeSesError(err), { cause: err })
    }

    await this.deps.store.write({
      region,
      accessKeyId,
      sealedSecretAccessKey: sealSecret(secretAccessKey, this.deps.key()),
      emailFrom,
      updatedBy,
    })
    this.cache = null
  }

  /**
   * Wires delivery events: an SNS topic, the two SES configuration sets
   * (general / with open+click tracking) pointing at it, and an HTTPS
   * subscription to `${origin}/api/mail/ses-events`. Idempotent — "Set up
   * again" re-runs it. The outcome is stored (never thrown): the Email page
   * shows it, with Amazon's reason when it failed.
   */
  async setupEvents(origin: string): Promise<OwleryEvents> {
    const { sns, settings } = await this.sns()
    const ses = this.client(settings)
    const names = eventResourceNames(origin)
    const callbackUrl = `${origin.replace(/\/+$/, '')}/api/mail/ses-events`
    let result: OwleryEvents
    try {
      const topicArn = await sns.createTopic(names.topic)
      await ses.ensureEventDestination({ configurationSet: names.configSet, topicArn, events: GENERAL_EVENTS })
      await ses.ensureEventDestination({ configurationSet: names.trackingConfigSet, topicArn, events: TRACKING_EVENTS })
      const { confirmed } = await sns.subscribeHttps(topicArn, callbackUrl)
      result = {
        eventsStatus: confirmed ? 'ready' : 'waiting',
        eventsError: null,
        eventsTopicArn: topicArn,
        eventsCallbackUrl: callbackUrl,
        configSet: names.configSet,
        trackingConfigSet: names.trackingConfigSet,
      }
    } catch (err) {
      result = {
        eventsStatus: 'failed',
        eventsError:
          err instanceof EventsSetupError
            ? err.message
            : awsErrorCode(err) === 'AuthorizationErrorException'
              ? 'These AWS keys may not use Amazon SNS, which tells ee when mail is delivered, bounces or is opened. Add the AmazonSNSFullAccess policy to the IAM user, then press "Set up again".'
              : describeSesError(err),
        eventsTopicArn: null,
        eventsCallbackUrl: callbackUrl,
        configSet: null,
        trackingConfigSet: null,
      }
    }
    await this.deps.store.writeEvents(result)
    this.cache = null
    return result
  }

  /** SNS confirmed (or cancelled) our subscription. */
  async markEvents(patch: Partial<OwleryEvents>): Promise<void> {
    await this.deps.store.writeEvents(patch)
    this.cache = null
  }
}

const host = globalThis as { __eeOwleryService?: OwleryService }

/** The mail transport this process runs with (MAIL_TRANSPORT, see transport.ts). Throws on bad config. */
export function configuredMailTransport(): MailTransport {
  return resolveMailTransport(env)
}

/**
 * The process-wide Owlery service (settings cached, invalidated on save).
 * MAIL_TRANSPORT=fake swaps Amazon SES + SNS for the database-backed fake.
 */
export function owleryService(): OwleryService {
  if (!host.__eeOwleryService) {
    const transport = configuredMailTransport()
    host.__eeOwleryService = new OwleryService({
      store: defaultOwleryStore(),
      log: defaultEmailStore(),
      key: () => {
        const master = env.TENANT_MASTER_KEY
        if (!master) throw new Error('TENANT_MASTER_KEY is required to unseal the Amazon SES secret')
        return owlerySealKey(master)
      },
      ...(transport === 'fake' ? { ses: fakeStoreSes(defaultFakeMailStore()), sns: fakeSns } : {}),
    })
  }
  return host.__eeOwleryService
}
