import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { APIError } from 'better-auth/api'
import { auth } from '$lib/server/auth'
import { isUserProviderReady } from '$lib/server/llm/provider-ready'

/**
 * Minimal Eigen Enterprise settings: Account (email + password), AI provider
 * status, API keys. The eigen feature surfaces (appearance, speech, push
 * notifications, memory tools, graph utilities) are gone from this page —
 * their server APIs live on untouched.
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

  const providerReady = await isUserProviderReady(event.locals.user.id)

  return {
    user: event.locals.user,
    providerReady,
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

  changePassword: async (event) => {
    if (!event.locals.user) {
      return fail(401, { passwordMessage: 'You must be signed in.' })
    }

    const formData = await event.request.formData()
    const currentPassword = formData.get('currentPassword')?.toString() ?? ''
    const newPassword = formData.get('newPassword')?.toString() ?? ''

    if (!currentPassword || !newPassword) {
      return fail(400, { passwordMessage: 'Please provide both current and new password.' })
    }
    if (newPassword.length < 8) {
      return fail(400, { passwordMessage: 'New password must be at least 8 characters.' })
    }

    try {
      await auth.api.changePassword({
        headers: event.request.headers,
        body: {
          currentPassword,
          newPassword,
          revokeOtherSessions: false,
        },
      })
      return { passwordMessage: 'Password updated successfully.' }
    } catch (error) {
      return fail(400, {
        passwordMessage: getSafeErrorMessage(error, 'Unable to change password.'),
      })
    }
  },
}
