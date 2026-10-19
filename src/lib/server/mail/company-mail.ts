import { createHash } from 'node:crypto'
import { decryptEnvelope, encryptEnvelope } from '$lib/server/crypto/envelope'
import type { OwleryEnv } from '$lib/server/owlery/config'
import { sendTransactionalEmail, type SendTransactionalEmailInput } from '$lib/server/owlery/mail'

/**
 * Company email delivery, configured by the owner in the onboarding and stored in
 * the database — never in env files. One provider today (Owlery). The API key is
 * sealed with a key derived from TENANT_MASTER_KEY and only unsealed per send.
 */

export type CompanyMailSettings = {
  provider: 'owlery'
  baseUrl: string
  emailFrom: string
  apiKey: string
  contactBookId: string | null
}

export type CompanyMailRow = Omit<CompanyMailSettings, 'apiKey'> & { sealedApiKey: string; updatedBy: string }

export type CompanyMailStore = {
  read(): Promise<CompanyMailRow | null>
  write(row: CompanyMailRow): Promise<void>
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Email delivery is not configured yet. The owner sets it up in the onboarding (or Settings → Email).')
  }
}

const AAD = 'company-mail-api-key'

export function mailSealKey(masterKey: string): Buffer {
  if (!masterKey.trim()) throw new Error('TENANT_MASTER_KEY is required to seal the email provider key')
  return createHash('sha256').update(`${AAD}:${masterKey.trim()}`, 'utf8').digest()
}

/** The Owlery env shape the existing client speaks, built from the DB settings. */
export function owleryEnvOf(s: CompanyMailSettings): OwleryEnv {
  return {
    OWLERY_API_KEY: s.apiKey,
    OWLERY_BASE_URL: s.baseUrl,
    OWLERY_EMAIL_FROM: s.emailFrom,
    ...(s.contactBookId ? { OWLERY_CONTACT_BOOK_ID: s.contactBookId } : {}),
  }
}

export type CompanyMailDeps = {
  store: CompanyMailStore
  key: () => Buffer
  send?: (env: OwleryEnv, input: SendTransactionalEmailInput) => Promise<unknown>
  now?: () => number
}

const CACHE_MS = 30_000

export class CompanyMail {
  private cache: { at: number; value: CompanyMailSettings | null } | null = null

  constructor(private readonly deps: CompanyMailDeps) {}

  async settings(): Promise<CompanyMailSettings | null> {
    const now = this.deps.now?.() ?? Date.now()
    if (this.cache && now - this.cache.at < CACHE_MS) return this.cache.value
    const row = await this.deps.store.read()
    const value = row
      ? {
          provider: row.provider,
          baseUrl: row.baseUrl,
          emailFrom: row.emailFrom,
          contactBookId: row.contactBookId,
          apiKey: decryptEnvelope(row.sealedApiKey, this.deps.key(), AAD),
        }
      : null
    this.cache = { at: now, value }
    return value
  }

  async isConfigured(): Promise<boolean> {
    return (await this.settings()) !== null
  }

  /** The Owlery env for this company, or null when email isn't set up. */
  async owleryEnv(): Promise<OwleryEnv | null> {
    const s = await this.settings()
    return s ? owleryEnvOf(s) : null
  }

  async send(input: SendTransactionalEmailInput): Promise<void> {
    const s = await this.settings()
    if (!s) throw new MailNotConfiguredError()
    await (this.deps.send ?? sendTransactionalEmail)(owleryEnvOf(s), input)
  }

  /**
   * Save settings only after a real test email went through with them — the
   * owner learns now, not at their next sign-in, that a key or sender is wrong.
   */
  async saveVerified(input: Omit<CompanyMailSettings, 'provider'> & { testRecipient: string; updatedBy: string }): Promise<void> {
    const settings: CompanyMailSettings = {
      provider: 'owlery',
      baseUrl: input.baseUrl.trim().replace(/\/$/, ''),
      emailFrom: input.emailFrom.trim(),
      apiKey: input.apiKey.trim(),
      contactBookId: input.contactBookId?.trim() || null,
    }
    if (!/^https?:\/\//.test(settings.baseUrl)) throw new Error('The Owlery address must start with https://')
    if (!settings.apiKey) throw new Error('The API key is required.')
    if (!settings.emailFrom) throw new Error('The sender address is required.')
    await (this.deps.send ?? sendTransactionalEmail)(owleryEnvOf(settings), {
      to: input.testRecipient,
      subject: 'Email works — Eigen Enterprise',
      text: 'This is the test email from your Eigen Enterprise setup. Sign-in codes and notifications will come from this address.',
      html: '<p>This is the test email from your Eigen Enterprise setup.</p><p>Sign-in codes and notifications will come from this address.</p>',
    })
    await this.deps.store.write({
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      emailFrom: settings.emailFrom,
      contactBookId: settings.contactBookId,
      sealedApiKey: encryptEnvelope(settings.apiKey, this.deps.key(), AAD),
      updatedBy: input.updatedBy,
    })
    this.cache = null
  }
}
