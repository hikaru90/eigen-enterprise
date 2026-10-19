import {
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2'

/**
 * The only place in eigenEnterprise that talks to Amazon SES (v2 API).
 * Everything above it works against the `SesApi` shape so tests inject a fake.
 */

export type SesCredentials = { region: string; accessKeyId: string; secretAccessKey: string }

export type IdentityInfo = { exists: boolean; verified: boolean }

export type SesSendInput = {
  from: string
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
}

export type SesApi = {
  /** GetEmailIdentity — `exists: false` when SES has never heard of it. */
  getIdentity(identity: string): Promise<IdentityInfo>
  /** CreateEmailIdentity — for an address, SES mails a verification link to it. */
  createIdentity(identity: string): Promise<void>
  /** GetAccount — true while the account can only send to verified addresses. */
  isSandbox(): Promise<boolean>
  send(input: SesSendInput): Promise<{ messageId: string | null }>
}

export type SesFactory = (credentials: SesCredentials) => SesApi

/** AWS error code (the SDK's exception `name`), or null for non-AWS errors. */
export function awsErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') {
    return '$metadata' in err ? err.name : null
  }
  return null
}

export const awsSes: SesFactory = (c) => {
  const client = new SESv2Client({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  })
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
      const out = await client.send(
        new SendEmailCommand({
          FromEmailAddress: input.from,
          Destination: { ToAddresses: [input.to] },
          ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
          Content: {
            Simple: {
              Subject: { Data: input.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: input.text, Charset: 'UTF-8' },
                Html: { Data: input.html, Charset: 'UTF-8' },
              },
            },
          },
        }),
      )
      return { messageId: out.MessageId ?? null }
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
    case 'MessageRejected':
      return `Amazon refused the email: ${err instanceof Error ? err.message : 'no reason given'}`
  }
  const netCode = err && typeof err === 'object' && 'code' in err ? err.code : null
  if (typeof netCode === 'string' && NETWORK_CODES.has(netCode)) {
    return 'Could not reach Amazon SES in this region. Check the region (for example eu-central-1).'
  }
  return `Amazon SES could not send: ${err instanceof Error ? err.message : String(err)}`
}
