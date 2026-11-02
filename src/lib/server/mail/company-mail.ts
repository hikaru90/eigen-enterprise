/**
 * The company's email contract, shared by every part of the app that sends mail.
 *
 * Delivery belongs to the Owlery email module (modules/email/owlery): it alone holds
 * the Amazon SES credentials and talks to SES. Everything else sends through
 * `companyMail()` from '$lib/server/mail' and never sees a credential.
 */

export type SendMailInput = {
  to: string
  subject: string
  html: string
  text: string
  /** Optional Reply-To so inbox replies reach the submitter. */
  replyTo?: string
}

export type SaveMailSettingsInput = {
  region: string
  accessKeyId: string
  secretAccessKey: string
  emailFrom: string
  /** A real test email goes here before anything is saved. */
  testRecipient: string
  updatedBy: string
}

export type CompanyMail = {
  isConfigured(): Promise<boolean>
  send(input: SendMailInput): Promise<{ messageId: string | null }>
  /**
   * Save the SES settings only after a real test email went through with them.
   * Throws SenderNotVerifiedError while Amazon still waits for the sender to
   * click its verification link; MailSetupError for everything else.
   */
  saveVerified(input: SaveMailSettingsInput): Promise<void>
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super(
      'Email delivery is not configured yet. The owner sets it up in the email step of the onboarding.',
    )
    this.name = 'MailNotConfiguredError'
  }
}

/** The sender address exists at Amazon but its owner has not clicked the verification link yet. */
export class SenderNotVerifiedError extends Error {
  constructor(readonly emailFrom: string) {
    super(
      `Amazon sent a verification email to ${emailFrom}. Open it, click the link inside, then try again.`,
    )
    this.name = 'SenderNotVerifiedError'
  }
}

/** A setup or delivery problem, already phrased for the person reading it. */
export class MailSetupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MailSetupError'
  }
}
