import { env } from '$lib/server/env/private-env'
import { companyOwleryEnv } from '$lib/server/mail'
import { isOwleryMailConfigured, sendTransactionalEmail } from '$lib/server/owlery/mail'

/** Product inbox for user-submitted feedback (Owlery transactional). */
export const FEEDBACK_INBOX_EMAIL =
  env.FEEDBACK_INBOX_EMAIL?.trim() || 'feedback@eigenenterprise.example'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Throws when Owlery mail is not configured — feedback delivery requires email. */
export async function assertFeedbackMailConfigured(): Promise<void> {
  if (!isOwleryMailConfigured(await companyOwleryEnv())) {
    throw new Error('Feedback email is not set up yet. The owner sets up email in the onboarding (or Settings → Email).')
  }
}

export type SendFeedbackInboxEmailInput = {
  feedbackId: string
  userId: string
  userEmail: string
  message: string
}

/**
 * Delivers product feedback to the feedback inbox via Owlery.
 * Propagates send failures — no silent swallow (see AGENTS.md failure policy).
 */
export async function sendFeedbackInboxEmail(
  input: SendFeedbackInboxEmailInput,
): Promise<{ emailId: string | null }> {
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

  return sendTransactionalEmail(await companyOwleryEnv(), {
    to: FEEDBACK_INBOX_EMAIL,
    replyTo: input.userEmail,
    subject,
    html,
    text,
  })
}
