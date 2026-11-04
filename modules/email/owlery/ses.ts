import {
  CreateConfigurationSetCommand,
  CreateConfigurationSetEventDestinationCommand,
  CreateEmailIdentityCommand,
  DeleteEmailIdentityCommand,
  DeleteSuppressedDestinationCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  SendEmailCommand,
  SESv2Client,
  type EventType,
} from '@aws-sdk/client-sesv2'

/**
 * The only place in eigenEnterprise that talks to Amazon SES (v2 API).
 * Everything above it works against the `SesApi` shape so tests inject a fake.
 */

export type SesCredentials = { region: string; accessKeyId: string; secretAccessKey: string }

export type IdentityInfo = { exists: boolean; verified: boolean }

export type MailHeader = { name: string; value: string }

export type SesSendInput = {
  from: string
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  /** SES configuration set: routes the delivery events to our SNS topic. */
  configurationSet?: string
  /** Extra headers (List-Unsubscribe …), never From/To/Subject. */
  headers?: MailHeader[]
  /** Message tags echoed back in every SES event (we tag our log id). */
  tags?: Record<string, string>
}

/** What SES says about a domain identity (GetEmailIdentity), in its own words. */
export type DomainIdentityInfo = {
  exists: boolean
  /** VerificationStatus: PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE | NOT_STARTED. */
  verification: string
  dkim: string
  mailFrom: string
  /** VerificationInfo.ErrorType (HOST_NOT_FOUND, INVALID_VALUE …) or null. */
  errorType: string | null
}

export type CreateDomainIdentityInput = {
  domain: string
  /** BYO-DKIM: our selector + the base64 PKCS#8 private key (never stored by ee). */
  dkimSelector: string
  dkimPrivateKey: string
  /** The MAIL FROM subdomain (mail.<domain>) for SPF alignment and bounce handling. */
  mailFromDomain: string
}

/** SES event types a configuration set forwards (SESv2 EventType values). */
export type SesEventType = EventType

export type SesApi = {
  /** GetEmailIdentity — `exists: false` when SES has never heard of it. */
  getIdentity(identity: string): Promise<IdentityInfo>
  /** CreateEmailIdentity — for an address, SES mails a verification link to it. */
  createIdentity(identity: string): Promise<void>
  /** GetAccount — true while the account can only send to verified addresses. */
  isSandbox(): Promise<boolean>
  send(input: SesSendInput): Promise<{ messageId: string | null }>
  /** CreateEmailIdentity with our DKIM key + PutEmailIdentityMailFromAttributes. */
  createDomainIdentity(input: CreateDomainIdentityInput): Promise<void>
  getDomainIdentity(domain: string): Promise<DomainIdentityInfo>
  /** DeleteEmailIdentity; a missing identity counts as deleted. */
  deleteIdentity(identity: string): Promise<void>
  /** CreateConfigurationSet + an SNS event destination; both idempotent. */
  ensureEventDestination(input: { configurationSet: string; topicArn: string; events: SesEventType[] }): Promise<void>
  /** DeleteSuppressedDestination (Amazon's account-level list); a missing entry counts as removed. */
  removeFromAccountSuppression(email: string): Promise<void>
}

export type SesFactory = (credentials: SesCredentials) => SesApi

/** AWS error code (the SDK's exception `name`), or null for non-AWS errors. */
export function awsErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return '$metadata' in err ? err.name : null
  }
  return null
}

const EVENT_DESTINATION_NAME = 'ee-events'

export const awsSes: SesFactory = (c) => {
  const client = new SESv2Client({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
  const ignore = async (code: string, run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (err) {
      if (awsErrorCode(err) !== code) throw err
    }
  }
  return {
    async getIdentity(identity) {
      try {
        const out = await client.send(new GetEmailIdentityCommand({ EmailIdentity: identity }))
        return { exists: true, verified: out.VerifiedForSendingStatus === true }
      } catch (err) {
        if (awsErrorCode(err) === 'NotFoundException') return { exists: false, verified: false }
        throw err
      }
    },
    async createIdentity(identity) {
      await client.send(new CreateEmailIdentityCommand({ EmailIdentity: identity }))
    },
    async isSandbox() {
      const out = await client.send(new GetAccountCommand({}))
      return out.ProductionAccessEnabled !== true
    },
    async send(input) {
      const tags = Object.entries(input.tags ?? {}).map(([Name, Value]) => ({ Name, Value }))
      const out = await client.send(
        new SendEmailCommand({
          FromEmailAddress: input.from,
          Destination: { ToAddresses: [input.to] },
          ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
          ...(input.configurationSet ? { ConfigurationSetName: input.configurationSet } : {}),
          ...(tags.length > 0 ? { EmailTags: tags } : {}),
          Content: {
            Simple: {
              Subject: { Data: input.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: input.text, Charset: 'UTF-8' },
                Html: { Data: input.html, Charset: 'UTF-8' },
              },
              ...(input.headers && input.headers.length > 0
                ? { Headers: input.headers.map((h) => ({ Name: h.name, Value: h.value })) }
                : {}),
            },
          },
        }),
      )
      return { messageId: out.MessageId ?? null }
    },
    async createDomainIdentity(input) {
      await client.send(
        new CreateEmailIdentityCommand({
          EmailIdentity: input.domain,
          DkimSigningAttributes: {
            DomainSigningSelector: input.dkimSelector,
            DomainSigningPrivateKey: input.dkimPrivateKey,
          },
        }),
      )
      await client.send(
        new PutEmailIdentityMailFromAttributesCommand({
          EmailIdentity: input.domain,
          MailFromDomain: input.mailFromDomain,
          BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
        }),
      )
    },
    async getDomainIdentity(domain) {
      try {
        const out = await client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }))
        return {
          exists: true,
          verification: String(out.VerificationStatus ?? 'NOT_STARTED'),
          dkim: String(out.DkimAttributes?.Status ?? 'NOT_STARTED'),
          mailFrom: String(out.MailFromAttributes?.MailFromDomainStatus ?? 'NOT_STARTED'),
          errorType: out.VerificationInfo?.ErrorType ? String(out.VerificationInfo.ErrorType) : null,
        }
      } catch (err) {
        if (awsErrorCode(err) === 'NotFoundException') {
          return { exists: false, verification: 'NOT_STARTED', dkim: 'NOT_STARTED', mailFrom: 'NOT_STARTED', errorType: null }
        }
        throw err
      }
    },
    async deleteIdentity(identity) {
      await ignore('NotFoundException', () => client.send(new DeleteEmailIdentityCommand({ EmailIdentity: identity })))
    },
    async ensureEventDestination({ configurationSet, topicArn, events }) {
      await ignore('AlreadyExistsException', () =>
        client.send(new CreateConfigurationSetCommand({ ConfigurationSetName: configurationSet })),
      )
      await ignore('AlreadyExistsException', () =>
        client.send(
          new CreateConfigurationSetEventDestinationCommand({
            ConfigurationSetName: configurationSet,
            EventDestinationName: EVENT_DESTINATION_NAME,
            EventDestination: { Enabled: true, MatchingEventTypes: events, SnsDestination: { TopicArn: topicArn } },
          }),
        ),
      )
    },
    async removeFromAccountSuppression(email) {
      await ignore('NotFoundException', () => client.send(new DeleteSuppressedDestinationCommand({ EmailAddress: email })))
    },
  }
}

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT'])

/** Plain-language explanation of an SES failure (keyed on the AWS error code). */
export function describeSesError(err: unknown): string {
  switch (awsErrorCode(err)) {
    case 'UnrecognizedClientException':
    case 'InvalidClientTokenId':
      return 'Amazon does not recognise this access key ID. Check that you copied it completely.'
    case 'SignatureDoesNotMatch':
    case 'IncompleteSignature':
      return 'The secret access key does not match the access key ID. Check that you copied it completely.'
    case 'AccessDeniedException':
    case 'AuthorizationErrorException':
      return 'These AWS keys are not allowed to use Amazon SES. Give the IAM user permission for SES (for example the AmazonSESFullAccess policy), then try again.'
    case 'AccountSuspendedException':
      return 'Amazon has suspended sending for this AWS account. Check the SES console for details.'
    case 'SendingPausedException':
      return 'Sending is paused for this AWS account. Resume it in the SES console, then try again.'
    case 'MailFromDomainNotVerifiedException':
      return 'The sender domain is not verified at Amazon yet.'
    case 'TooManyRequestsException':
    case 'LimitExceededException':
      return 'Amazon is limiting how fast this account sends right now. Wait a moment and try again.'
    case 'AlreadyExistsException':
      return 'Amazon already has this domain in your account. Remove it in the SES console first, or add it here under a different region.'
    case 'MessageRejected':
      return `Amazon refused the email: ${err instanceof Error ? err.message : 'no reason given'}`
  }
  const netCode = err && typeof err === 'object' && 'code' in err ? err.code : null
  if (typeof netCode === 'string' && NETWORK_CODES.has(netCode)) {
    return 'Could not reach Amazon SES in this region. Check the region (for example eu-central-1).'
  }
  return `Amazon SES could not do this: ${err instanceof Error ? err.message : String(err)}`
}
