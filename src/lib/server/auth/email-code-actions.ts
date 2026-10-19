import { fail, redirect, type RequestEvent } from '@sveltejs/kit'
import { auth } from '$lib/server/auth'
import { getSafeErrorMessage } from '$lib/server/auth-form-errors'
import { emailCodeRequestSchema, emailCodeVerifySchema, signUpCodeRequestSchema } from '$lib/validation/auth'

/**
 * Passwordless form actions shared by /signup and /login (Better Auth emailOTP).
 * Step 1 emails a 6-digit code; step 2 verifies it, which signs in an existing
 * account or creates a new one (the owner policy decides whether that's allowed).
 */

export async function requestCode(event: RequestEvent, opts: { requireTerms: boolean }) {
  const form = await event.request.formData()
  const raw = { email: form.get('email')?.toString() ?? '', acceptTerms: form.get('acceptTerms') ?? undefined }
  const parsed = opts.requireTerms ? signUpCodeRequestSchema.safeParse(raw) : emailCodeRequestSchema.safeParse(raw)
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>
    return fail(400, { step: 'email' as const, email: raw.email, message: f.email?.[0] ?? f.acceptTerms?.[0] ?? 'Invalid input' })
  }
  try {
    await auth.api.sendVerificationOTP({ body: { email: parsed.data.email, type: 'sign-in' } })
  } catch (error) {
    return fail(503, { step: 'email' as const, email: parsed.data.email, message: getSafeErrorMessage(error, 'Could not send the code') })
  }
  return { step: 'code' as const, email: parsed.data.email, notice: `We sent a 6-digit code to ${parsed.data.email}.` }
}

export async function verifyCode(event: RequestEvent) {
  const form = await event.request.formData()
  const raw = { email: form.get('email')?.toString() ?? '', code: form.get('code')?.toString() ?? '' }
  const parsed = emailCodeVerifySchema.safeParse(raw)
  if (!parsed.success) {
    const f = parsed.error.flatten().fieldErrors
    return fail(400, { step: 'code' as const, email: raw.email, message: f.code?.[0] ?? f.email?.[0] ?? 'Invalid input' })
  }
  try {
    await auth.api.signInEmailOTP({ body: { email: parsed.data.email, otp: parsed.data.code } })
  } catch (error) {
    return fail(400, { step: 'code' as const, email: parsed.data.email, message: getSafeErrorMessage(error, 'That code did not work') })
  }
  throw redirect(302, '/')
}
