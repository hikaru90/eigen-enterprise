/**
 * Passwordless sign-in: delivers Better Auth's email OTP. One code both signs
 * up a new address and signs in an existing one (emailOTP "sign-in" type).
 *
 * Delivery is email only. Without a configured mailer, production refuses to
 * pretend a code was sent (fail loud) and never writes the code to a log; dev
 * prints it to the terminal and records it for the Playwright harness.
 */

export class EmailDeliveryNotConfiguredError extends Error {
  constructor() {
    super(
      "This company hasn't set up email yet, so sign-in codes can't be sent. The owner sets up email in the onboarding (or Settings → Email).",
    )
  }
}

export type OutgoingEmail = { to: string; subject: string; text: string; html: string }

export type DeliverDeps = {
  mailConfigured: boolean
  dev: boolean
  send: (mail: OutgoingEmail) => Promise<unknown>
  log: (line: string) => void
  record: (email: string, otp: string) => void
}

export function signInCodeEmail(to: string, otp: string): OutgoingEmail {
  const text = `Your Eigen Enterprise sign-in code is ${otp}.\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`
  const html =
    `<p>Your Eigen Enterprise sign-in code is</p>` +
    `<p style="font-size:28px;letter-spacing:6px;font-family:ui-monospace,monospace"><strong>${otp}</strong></p>` +
    `<p>It expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`
  return { to, subject: `Your Eigen Enterprise code: ${otp}`, text, html }
}

export async function deliverSignInCode(input: { email: string; otp: string }, deps: DeliverDeps): Promise<void> {
  if (deps.dev) deps.record(input.email, input.otp)
  if (deps.mailConfigured) {
    await deps.send(signInCodeEmail(input.email, input.otp))
    return
  }
  if (!deps.dev) throw new EmailDeliveryNotConfiguredError()
  deps.log(`[auth] DEV sign-in code for ${input.email}: ${input.otp}`)
}

/**
 * Better Auth runs `sendVerificationOTP` through runInBackgroundOrAwait, which
 * awaits but SWALLOWS errors (logs "Failed to run background task"). So the
 * sender records a failure per address and the form action checks it after the
 * call — otherwise the page would say "we sent a code" when nothing went out.
 */
const deliveryFailures = new Map<string, Error>()

export function recordDeliveryFailure(email: string, err: unknown): void {
  deliveryFailures.set(email.trim().toLowerCase(), err instanceof Error ? err : new Error(String(err)))
}

export function takeDeliveryFailure(email: string): Error | null {
  const key = email.trim().toLowerCase()
  const err = deliveryFailures.get(key) ?? null
  deliveryFailures.delete(key)
  return err
}
