/**
 * Which mail transport the running app uses (plan/phase-module-readiness.md E1).
 *
 *   MAIL_TRANSPORT unset   → Amazon SES (the default for every real install)
 *   MAIL_TRANSPORT=ses     → Amazon SES (explicit)
 *   MAIL_TRANSPORT=fake    → FakeSes, mails captured in the database
 *                            (mail_fake_sent), readable via /api/e2e/harness/mail
 *
 * `fake` is refused when NODE_ENV=production unless the local test server also
 * sets MAIL_TRANSPORT_FAKE_IN_PRODUCTION=1. Any other value fails loud — there
 * is no silent fallback to SES.
 */

export type MailTransport = 'ses' | 'fake'

export type MailTransportEnv = {
  MAIL_TRANSPORT?: string
  MAIL_TRANSPORT_FAKE_IN_PRODUCTION?: string
  NODE_ENV?: string
}

export class MailTransportConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailTransportConfigError'
  }
}

export function resolveMailTransport(env: MailTransportEnv): MailTransport {
  const raw = env.MAIL_TRANSPORT
  const override = env.MAIL_TRANSPORT_FAKE_IN_PRODUCTION
  if (override !== undefined && override !== '1') {
    throw new MailTransportConfigError(
      `MAIL_TRANSPORT_FAKE_IN_PRODUCTION="${override}" is not valid. Leave it unset or set it to 1.`,
    )
  }
  if (raw === undefined || raw === 'ses') {
    if (override !== undefined) {
      throw new MailTransportConfigError(
        'MAIL_TRANSPORT_FAKE_IN_PRODUCTION only means something together with MAIL_TRANSPORT=fake. Remove it.',
      )
    }
    return 'ses'
  }
  if (raw !== 'fake') {
    throw new MailTransportConfigError(
      `MAIL_TRANSPORT="${raw}" is not a known mail transport. Use "ses" (Amazon SES, also the default when unset) or "fake" (tests only).`,
    )
  }
  if (env.NODE_ENV === 'production' && override !== '1') {
    throw new MailTransportConfigError(
      'MAIL_TRANSPORT=fake is refused in production: no email would ever reach anyone. ' +
        'Only the local test server may run it, and it must also set MAIL_TRANSPORT_FAKE_IN_PRODUCTION=1.',
    )
  }
  return 'fake'
}
