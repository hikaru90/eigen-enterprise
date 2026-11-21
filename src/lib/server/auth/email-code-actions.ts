import { fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { auth } from '$lib/server/auth'
import { signInHeaders } from './sign-in-headers'
import { takeDeliveryFailure } from '$lib/server/auth/deliver-code'
import { signInRefusal } from '$lib/server/auth/unclaimed'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { publicErrorReport } from '$lib/server/auth/public-error-report'
import {
  emailCodeRequestSchema,
  emailCodeVerifySchema,
  signUpCodeRequestSchema,
} from '$lib/validation/auth'

/**
 * Passwordless form actions shared by /signup and /login (Better Auth emailOTP).
 * Step 1 emails a 6-digit code; step 2 verifies it, which signs in an existing
 * account or creates a new one (the owner policy decides whether that's allowed).
 */

/** The person's sentence (`message`, unchanged) + the signed-out agent half (no email, no code). */
function refused(sentence: string, attempted: string, err?: unknown, nextSteps?: string[]) {
  const { error, agent } = publicErrorReport(sentence, {
    attempted,
    err,
    ...(nextSteps ? { nextSteps } : {}),
  })
  return { message: error, agent }
}

const SEND_ATTEMPT = 'Sending a sign-in code by email (passwordless sign-in, step 1)'
const VERIFY_ATTEMPT = 'Checking the emailed sign-in code (passwordless sign-in, step 2)'

export async function requestCode(event: RequestEvent, opts: { requireTerms: boolean }) {
  const form = await event.request.formData()
  const raw = {
    email: form.get('email')?.toString() ?? '',
    acceptTerms: form.get('acceptTerms') ?? undefined,
  }
  const parsed = opts.requireTerms
    ? signUpCodeRequestSchema.safeParse(raw)
    : emailCodeRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>
    return fail(400, {
      step: 'email' as const,
      email: raw.email,
      ...refused(f.email?.[0] ?? f.acceptTerms?.[0] ?? 'Invalid input', SEND_ATTEMPT, undefined, [
        'The form was refused by its schema in src/lib/validation/auth.ts before any code was sent; the sentence names the field.',
      ]),
    })
  }
  // On a claimed ee server only members get a code; everyone else gets a plain answer.
  const refusal = await signInRefusal(parsed.data.email)
  if (refusal) {
    return fail(403, {
      step: 'email' as const,
      email: parsed.data.email,
      ...refused(refusal, SEND_ATTEMPT, undefined, [
        'Only members get a sign-in code on a claimed server (signInRefusal in src/lib/server/auth/unclaimed.ts). The owner invites the person from Settings → Members.',
      ]),
    })
  }
  try {
    takeDeliveryFailure(parsed.data.email) // clear any stale failure
    await auth.api.sendVerificationOTP({ body: { email: parsed.data.email, type: 'sign-in' } })
    const failure = takeDeliveryFailure(parsed.data.email)
    if (failure) throw failure
  } catch (error) {
    console.error('[auth] sending the sign-in code failed', error)
    return fail(503, {
      step: 'email' as const,
      email: parsed.data.email,
      ...refused(getSafeErrorMessage(error, 'Could not send the code'), SEND_ATTEMPT, error, [
        'The code email could not be sent (auth.api.sendVerificationOTP / deliver-code.ts). Check the company mail setup (Email module) and the server journal at the time above.',
      ]),
    })
  }
  return {
    step: 'code' as const,
    email: parsed.data.email,
    notice: `We sent a 6-digit code to ${parsed.data.email}.`,
  }
}

export async function verifyCode(event: RequestEvent) {
  const form = await event.request.formData()
  const raw = {
    email: form.get('email')?.toString() ?? '',
    code: form.get('code')?.toString() ?? '',
  }
  const parsed = emailCodeVerifySchema.safeParse(raw)
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors
    return fail(400, {
      step: 'code' as const,
      email: raw.email,
      ...refused(f.code?.[0] ?? f.email?.[0] ?? 'Invalid input', VERIFY_ATTEMPT, undefined, [
        'The code form was refused by emailCodeVerifySchema (src/lib/validation/auth.ts) before Better Auth ran.',
      ]),
    })
  }
  try {
    await auth.api.signInEmailOTP({
      body: { email: parsed.data.email, otp: parsed.data.code },
      headers: signInHeaders(event),
    })
  } catch (error) {
    return fail(400, {
      step: 'code' as const,
      email: parsed.data.email,
      ...refused(getSafeErrorMessage(error, 'That code did not work'), VERIFY_ATTEMPT, error, [
        "Better Auth refused the code (auth.api.signInEmailOTP) or the owner policy refused the new account. A wrong or expired code is the person's to retry; anything else is in the server journal.",
      ]),
    })
  }
  throw redirect(302, '/')
}
