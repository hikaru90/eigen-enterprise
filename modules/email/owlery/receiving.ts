import { MailNotConfiguredError } from '$lib/server/mail/company-mail'
import {
  INBOUND_CALLBACK_PATH,
  INBOUND_RULE_PREFIX,
  INBOUND_RULE_SET,
  INBOUND_TOPIC_NAME,
  RECIPIENTS_PER_RULE,
} from '../inbox/receiving-contract'
import { fakeTransportReceiving } from './fake-receiving'
import { fakeSns } from './fake-store'
import {
  awsInboundBucket,
  BucketOwnedElsewhereError,
  inboundBucketName,
  inboundBucketPolicy,
  type InboundBucketFactory,
} from './inbound-bucket'
import { configuredMailTransport, owleryService } from './service'
import { awsErrorCode, type SesCredentials } from './ses'
import { awsSesReceiving, type InboundRule, type SesReceivingFactory } from './ses-receiving'
import { awsSns, EventsSetupError, type SnsFactory } from './sns'
import { defaultOwleryStore, type OwleryReceiving, type OwleryStore } from './store'

/**
 * Receiving setup (plan/email-inbox.md S2): the AWS side of the company's
 * inbox. `setup` provisions, in this order:
 *
 *   1. the active receipt rule set is read — another set (not ours) stops
 *      everything: only one set can be active per account and ee never replaces it;
 *   2. the SNS topic (its ARN gives the AWS account id — no STS call) is stored
 *      before anything subscribes to it, so an early confirmation finds it;
 *   3. the S3 bucket: private, SSE-S3, writable only by SES for our rule set;
 *   4. the HTTPS subscription to /api/mail/ses-inbound (S3's ingest confirms it
 *      and flips the status to ready);
 *   5. the `ee-inbound` rule set, created and activated;
 *   6. the rules (`syncRules`).
 *
 * The outcome is stored, never thrown (Setup › Account shows it, with Amazon's
 * reason in plain words). `syncRules` keeps the rules' recipients equal to the
 * addresses that should receive mail; it throws ReceivingSetupError and stores
 * the reason when Amazon refuses.
 */

export type ReceivingDeps = {
  store: OwleryStore
  /** The saved Amazon SES credentials, or null before SES is connected. */
  credentials: () => Promise<SesCredentials | null>
  ses: SesReceivingFactory
  bucket: InboundBucketFactory
  sns: SnsFactory
}

export type ReceivingState = OwleryReceiving & {
  region: string
  /** The bucket the IAM policy names: the stored one, the one setup will create, or a pattern before the account is known. */
  policyBucket: string
}

/** A receiving problem already phrased for the owner. */
export class ReceivingSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ReceivingSetupError'
  }
}

/** arn:aws:<service>:<region>:<account>:<resource> → the 12-digit account id. */
export function accountIdFromArn(arn: string): string {
  const account = arn.split(':')[4]
  if (!arn.startsWith('arn:') || !account || !/^\d{12}$/.test(account)) {
    throw new Error(`not an AWS ARN with an account id: ${arn}`)
  }
  return account
}

/** The IAM policy the company's keys need for receiving, on top of AmazonSESFullAccess + AmazonSNSFullAccess. */
export function receivingIamPolicy(bucket: string): object {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'EeInboundBucket',
        Effect: 'Allow',
        Action: ['s3:CreateBucket', 's3:PutBucketPolicy', 's3:PutBucketPublicAccessBlock', 's3:PutEncryptionConfiguration'],
        Resource: [`arn:aws:s3:::${bucket}`],
      },
      {
        Sid: 'EeInboundMail',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:DeleteObject'],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  }
}

const AGAIN = 'then press "Set up receiving" again.'

/** One provisioning step: what it does in plain words, and the service/permission it needs. */
type Step =
  | { service: 's3'; permission: string; what: string; bucket?: string }
  | { service: 'sns'; what: string }
  | { service: 'ses'; what: string; bucket?: string }

/** The step's AWS failure in plain words (keyed on the AWS error code, never on the message). */
function describeStepError(step: Step, err: unknown): string {
  // Already phrased for the owner (a ReceivingSetupError, or the SNS seam refusing a non-https callback).
  if (err instanceof ReceivingSetupError || err instanceof EventsSetupError) return err.message
  if (err instanceof BucketOwnedElsewhereError) {
    return `Amazon says the S3 bucket name ${err.bucket} belongs to another AWS account, so ee can't store your mail there. ee names the bucket after your AWS account id; check in the S3 console who created it, ${AGAIN}`
  }
  const code = awsErrorCode(err)
  const reason = err instanceof Error ? err.message : String(err)
  if (step.service === 's3') {
    if (code === 'AccessDenied' || code === 'AccessDeniedException') {
      return `These AWS keys may not ${step.what} (the ${step.permission} permission is missing). Add the IAM policy shown under Receiving to the IAM user, ${AGAIN}`
    }
    return `Amazon S3 could not ${step.what}: ${reason}`
  }
  if (step.service === 'sns') {
    if (code === 'AuthorizationErrorException' || code === 'AccessDenied' || code === 'AccessDeniedException') {
      return `These AWS keys may not use Amazon SNS, which tells ee when mail arrives. Add the AmazonSNSFullAccess policy to the IAM user, ${AGAIN}`
    }
    return `Amazon SNS could not ${step.what}: ${reason}`
  }
  switch (code) {
    case 'AccessDenied':
    case 'AccessDeniedException':
      return `These AWS keys may not manage Amazon SES receipt rules. Give the IAM user the AmazonSESFullAccess policy, ${AGAIN}`
    case 'InvalidS3ConfigurationException':
      return `Amazon SES may not write into the S3 bucket ${step.bucket ?? ''}. Check that its bucket policy was not changed in the S3 console, ${AGAIN}`
    case 'InvalidSnsTopicException':
      return `Amazon SES may not notify the SNS topic ${INBOUND_TOPIC_NAME}. Check that the topic still exists in the SNS console, ${AGAIN}`
    case 'LimitExceededException':
      return `Amazon refused to ${step.what}: this account has reached an SES receiving limit (${reason}).`
  }
  return `Amazon SES could not ${step.what}: ${reason}`
}

async function run<T>(step: Step, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw new ReceivingSetupError(describeStepError(step, err), { cause: err })
  }
}

const isOurRule = (name: string) =>
  name.startsWith(INBOUND_RULE_PREFIX) && /^\d+$/.test(name.slice(INBOUND_RULE_PREFIX.length))

const sameRule = (a: InboundRule, b: InboundRule) =>
  a.bucket === b.bucket && a.topicArn === b.topicArn && a.recipients.join('\n') === [...b.recipients].sort().join('\n')

export class ReceivingService {
  constructor(private readonly deps: ReceivingDeps) {}

  async state(): Promise<ReceivingState | null> {
    const row = await this.deps.store.read()
    if (!row) return null
    const knownArn = row.receivingTopicArn ?? row.eventsTopicArn
    const policyBucket =
      row.receivingBucket ?? (knownArn ? inboundBucketName(accountIdFromArn(knownArn), row.region) : `ee-inbound-*-${row.region}`)
    return {
      region: row.region,
      policyBucket,
      receivingStatus: row.receivingStatus,
      receivingError: row.receivingError,
      receivingTopicArn: row.receivingTopicArn,
      receivingBucket: row.receivingBucket,
      receivingRuleSet: row.receivingRuleSet,
      receivingCallbackUrl: row.receivingCallbackUrl,
    }
  }

  private async credentials(): Promise<SesCredentials> {
    const c = await this.deps.credentials()
    if (!c) throw new MailNotConfiguredError()
    return c
  }

  /** Provisions (or re-checks) everything receiving needs, then syncs the rules. Idempotent. */
  async setup(origin: string, recipients: string[]): Promise<OwleryReceiving> {
    const c = await this.credentials()
    const ses = this.deps.ses(c)
    const sns = this.deps.sns(c)
    const s3 = this.deps.bucket(c)
    const callbackUrl = `${origin.replace(/\/+$/, '')}${INBOUND_CALLBACK_PATH}`
    try {
      const active = await run({ service: 'ses', what: 'read the active receipt rule set' }, () => ses.activeRuleSet())
      if (active !== null && active !== INBOUND_RULE_SET) {
        throw new ReceivingSetupError(
          `Your AWS account already receives mail with another receipt rule set ("${active}"). Amazon allows only one active rule set per account, and ee won't replace it, because that would stop the mail it handles. Deactivate it in the Amazon SES console (or move its rules elsewhere), ${AGAIN}`,
        )
      }
      const topicArn = await run({ service: 'sns', what: 'create the topic for new mail' }, () => sns.createTopic(INBOUND_TOPIC_NAME))
      const accountId = accountIdFromArn(topicArn)
      await this.deps.store.writeReceiving({ receivingTopicArn: topicArn, receivingCallbackUrl: callbackUrl })

      const bucket = inboundBucketName(accountId, c.region)
      await run({ service: 's3', permission: 's3:CreateBucket', what: `create the S3 bucket ${bucket}` }, () => s3.create(bucket))
      await run({ service: 's3', permission: 's3:PutBucketPublicAccessBlock', what: `make the bucket ${bucket} private` }, () =>
        s3.blockPublicAccess(bucket),
      )
      await run({ service: 's3', permission: 's3:PutEncryptionConfiguration', what: `turn on encryption for the bucket ${bucket}` }, () =>
        s3.encrypt(bucket),
      )
      await run({ service: 's3', permission: 's3:PutBucketPolicy', what: `let Amazon SES write into the bucket ${bucket}` }, () =>
        s3.putPolicy(bucket, inboundBucketPolicy({ bucket, accountId, region: c.region, ruleSet: INBOUND_RULE_SET })),
      )
      await this.deps.store.writeReceiving({ receivingBucket: bucket, receivingStatus: 'waiting', receivingError: null })

      const { confirmed } = await run({ service: 'sns', what: 'subscribe ee to new mail' }, () => sns.subscribeHttps(topicArn, callbackUrl))
      // Not confirmed yet: leave the status alone — S3's callback may already have set it to ready.
      if (confirmed) await this.deps.store.writeReceiving({ receivingStatus: 'ready' })

      await run({ service: 'ses', what: `create the receipt rule set ${INBOUND_RULE_SET}` }, () => ses.createRuleSet(INBOUND_RULE_SET))
      if (active !== INBOUND_RULE_SET) {
        await run({ service: 'ses', what: `activate the receipt rule set ${INBOUND_RULE_SET}` }, () => ses.activateRuleSet(INBOUND_RULE_SET))
      }
      await this.deps.store.writeReceiving({ receivingRuleSet: INBOUND_RULE_SET })
      await this.syncRules(recipients)
    } catch (err) {
      if (!(err instanceof ReceivingSetupError)) throw err
      await this.deps.store.writeReceiving({ receivingStatus: 'failed', receivingError: err.message, receivingCallbackUrl: callbackUrl })
    }
    const row = await this.deps.store.read()
    if (!row) throw new MailNotConfiguredError()
    return {
      receivingStatus: row.receivingStatus,
      receivingError: row.receivingError,
      receivingTopicArn: row.receivingTopicArn,
      receivingBucket: row.receivingBucket,
      receivingRuleSet: row.receivingRuleSet,
      receivingCallbackUrl: row.receivingCallbackUrl,
    }
  }

  /**
   * Makes the rules `ee-inbound-1..n` accept exactly these addresses (≤ 100
   * per rule): changed rules are updated, missing ones created, surplus ones
   * deleted. No addresses → no rules, and SES blocks the mail.
   */
  async syncRules(recipients: string[]): Promise<{ rules: number }> {
    const wanted = [...new Set(recipients.map((r) => r.trim().toLowerCase()))].sort()
    const row = await this.deps.store.read()
    const ruleSet = row?.receivingRuleSet
    const bucket = row?.receivingBucket
    const topicArn = row?.receivingTopicArn
    if (!row || !ruleSet || !bucket || !topicArn) {
      if (wanted.length === 0) return { rules: 0 }
      throw new ReceivingSetupError(
        'Receiving is not set up yet, so these addresses get no mail. Press "Set up receiving" under Email › Setup › Account.',
      )
    }
    const c = await this.credentials()
    const ses = this.deps.ses(c)
    const rules: InboundRule[] = []
    for (let i = 0; i < wanted.length; i += RECIPIENTS_PER_RULE) {
      rules.push({ name: `${INBOUND_RULE_PREFIX}${rules.length + 1}`, recipients: wanted.slice(i, i + RECIPIENTS_PER_RULE), bucket, topicArn })
    }
    try {
      const existing = (await run({ service: 'ses', what: 'read the receipt rules' }, () => ses.listRules(ruleSet))).filter((r) =>
        isOurRule(r.name),
      )
      const byName = new Map(existing.map((r) => [r.name, r]))
      for (const rule of rules) {
        const now = byName.get(rule.name)
        if (now && sameRule(rule, now)) continue
        const step = { service: 'ses' as const, what: `update the receipt rule ${rule.name}`, bucket }
        await run(step, () => (now ? ses.updateRule(ruleSet, rule) : ses.createRule(ruleSet, rule)))
      }
      const keep = new Set(rules.map((r) => r.name))
      for (const r of existing) {
        if (keep.has(r.name)) continue
        await run({ service: 'ses', what: `remove the receipt rule ${r.name}` }, () => ses.deleteRule(ruleSet, r.name))
      }
    } catch (err) {
      if (err instanceof ReceivingSetupError) await this.deps.store.writeReceiving({ receivingError: err.message })
      throw err
    }
    if (row.receivingError !== null && row.receivingStatus !== 'failed') await this.deps.store.writeReceiving({ receivingError: null })
    return { rules: rules.length }
  }
}

const host = globalThis as { __eeReceivingService?: ReceivingService }

/** The process-wide receiving service. MAIL_TRANSPORT=fake swaps Amazon for in-memory fakes. */
export function receivingService(): ReceivingService {
  if (!host.__eeReceivingService) {
    const fake = configuredMailTransport() === 'fake' ? fakeTransportReceiving() : null
    const owlery = owleryService()
    host.__eeReceivingService = new ReceivingService({
      store: defaultOwleryStore(),
      credentials: () => owlery.settings(),
      ses: fake ? fake.ses.factory : awsSesReceiving,
      bucket: fake ? fake.bucket.factory : awsInboundBucket,
      sns: fake ? fakeSns : awsSns,
    })
  }
  return host.__eeReceivingService
}
