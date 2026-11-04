import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { APIError } from 'better-auth/api'
import { auth } from '$lib/server/auth'
import { getProfile } from '$lib/server/profile/service'

/**
 * Settings → Account: the signed-in person's profile (names + picture, the
 * same editor as the profile step), email and sign-out. Sign-in is
 * passwordless (code + passkey), so there is no password to change. The other
 * company-wide sections (members, AI provider, passkeys, API keys, approval
 * mode) are their own pages under the settings sub-navigation.
 */

const getSafeErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof APIError) return error.message || fallback
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const msg = (error as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim().length > 0) return msg
  }
  return fallback
}

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }
  const p = await getProfile(event.locals.user.id)
  return {
    user: event.locals.user,
    profile: { firstName: p.firstName, lastName: p.lastName, name: p.name, email: p.email, image: p.image, complete: p.complete },
  }
}

export const actions: Actions = {
  changeEmail: async (event) => {
    if (!event.locals.user) {
      return fail(401, { emailMessage: 'You must be signed in.' })
    }

    const formData = await event.request.formData()
    const newEmail = formData.get('newEmail')?.toString().trim().toLowerCase() ?? ''
    if (!newEmail) {
      return fail(400, { emailMessage: 'Please provide a valid email.' })
    }

    try {
      await auth.api.changeEmail({
        headers: event.request.headers,
        body: {
          newEmail,
        },
      })
      return {
        emailMessage:
          'If your account requires email confirmation, check your inbox; otherwise your email was updated.',
      }
    } catch (error) {
      return fail(400, { emailMessage: getSafeErrorMessage(error, 'Unable to change email.') })
    }
  },
}
