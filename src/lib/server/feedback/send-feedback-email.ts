import { env } from '$lib/server/env/private-env'
import { companyMail } from '$lib/server/mail'

/** Product inbox for user-submitted feedback (company email). */
export const FEEDBACK_INBOX_EMAIL =
  env.FEEDBACK_INBOX_EMAIL?.trim() || 'feedback@eigenenterprise.example'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Throws when company email is not set up — feedback delivery requires email. */
export async function assertFeedbackMailConfigured(): Promise<void> {
  if (!(await companyMail().isConfigured())) {
    throw new Error('Feedback email is not set up yet. The owner sets up email in the email step of the onboarding.')
  }
}

export type SendFeedbackInboxEmailInput = {
  feedbackId: string
  userId: string
  userEmail: string
  message: string
}

/**
 * Delivers product feedback to the feedback inbox via company email.
 * Propagates send failures — no silent swallow (see AGENTS.md failure policy).
 */
export async function sendFeedbackInboxEmail(
  input: SendFeedbackInboxEmailInput,
): Promise<{ messageId: string | null }> {
  const subject = `[Eigen Enterprise] Product feedback from ${input.userEmail}`
  const text = [
    'New product feedback',
    '',
    `From: ${input.userEmail}`,
    `User id: ${input.userId}`,
    `Feedback id: ${input.feedbackId}`,
    '',
    input.message,
  ].join('\n')

  const html = [
    `<p style="font-size:16px;font-weight:600;margin:0 0 12px">New product feedback</p>`,
    `<p style="margin:0 0 8px"><strong>From:</strong> ${escapeHtml(input.userEmail)}</p>`,
    `<p style="margin:0 0 8px"><strong>User id:</strong> ${escapeHtml(input.userId)}</p>`,
    `<p style="margin:0 0 16px"><strong>Feedback id:</strong> ${escapeHtml(input.feedbackId)}</p>`,
    `<p style="margin:0;white-space:pre-line">${escapeHtml(input.message)}</p>`,
  ].join('')

  return companyMail().send({
    to: FEEDBACK_INBOX_EMAIL,
    replyTo: input.userEmail,
    subject,
    html,
    text,
  })
}
