import { z } from 'zod'
import { env } from '$lib/server/env/private-env'
import {
  MailNotConfiguredError,
  MailSetupError,
  SenderNotVerifiedError,
  type CompanyMail,
  type SaveMailSettingsInput,
  type SendMailInput,
} from '$lib/server/mail/company-mail'
import { awsErrorCode, awsSes, describeSesError, type SesApi, type SesCredentials, type SesFactory } from './ses'
import { defaultOwleryStore, owlerySealKey, sealSecret, unsealSecret, type OwleryStore } from './store'

export type OwlerySettings = SesCredentials & { emailFrom: string }

export type OwleryStatus =
  | { configured: false }
  | { configured: true; region: string; sender: string; senderVerified: boolean; sandbox: boolean }

export type OwleryServiceDeps = {
  store: OwleryStore
  key: () => Buffer
  ses?: SesFactory
  now?: () => number
}

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

/** Owns the SES settings and every send. The process singleton is `owleryService()`. */
export class OwleryService implements CompanyMail {
  private cache: { at: number; value: OwlerySettings | null } | null = null
  private readonly ses: SesFactory

  constructor(private readonly deps: OwleryServiceDeps) {
    this.ses = deps.ses ?? awsSes
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
        }
      : null
    this.cache = { at: now, value }
    return value
  }

  async isConfigured(): Promise<boolean> {
    return (await this.settings()) !== null
  }

  private client(s: OwlerySettings): SesApi {
    return this.ses({ region: s.region, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey })
  }

  async send(input: SendMailInput): Promise<{ messageId: string | null }> {
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    try {
      return await this.client(s).send({ from: s.emailFrom, ...input })
    } catch (err) {
      throw new MailSetupError(describeSesError(err), { cause: err })
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

  async saveVerified(input: SaveMailSettingsInput): Promise<void> {
    const parsed = settingsInput.safeParse(input)
    if (!parsed.success) throw new MailSetupError(parsed.error.issues[0]?.message ?? 'The email settings are incomplete.')
    const { region, accessKeyId, secretAccessKey, emailFrom, testRecipient, updatedBy } = parsed.data
    const ses = this.ses({ region, accessKeyId, secretAccessKey })

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
}

const host = globalThis as { __eeOwleryService?: OwleryService }

/** The process-wide Owlery service (settings cached, invalidated on save). */
export function owleryService(): OwleryService {
  host.__eeOwleryService ??= new OwleryService({
    store: defaultOwleryStore(),
    key: () => {
      const master = env.TENANT_MASTER_KEY
      if (!master) throw new Error('TENANT_MASTER_KEY is required to unseal the Amazon SES secret')
      return owlerySealKey(master)
    },
  })
  return host.__eeOwleryService
}
